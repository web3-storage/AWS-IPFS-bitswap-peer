'use strict'

const config = require('./config')
const { serializeError } = require('./logging')
const { Entry, BITSWAP_V_120, BLOCK_TYPE_INFO, BLOCK_TYPE_DATA } = require('./protocol')
const { Message } = require('./protocol')
const { fetchBlocksData, fetchBlocksInfo } = require('./storage')
const { telemetry } = require('./telemetry')
const { connectPeer } = require('./networking')
const inspect = require('./inspect')
const { cidToKey, sizeofBlockInfo } = require('./util')

function createContext({ service, peerId, protocol, wantlist, awsClient, connection }) {
  const context = {
    state: 'ok',
    connection,
    connecting: connection ? Promise.resolve() : null,
    awsClient,
    service,
    peerId,
    protocol,
    blocks: wantlist.entries,
    done: 0,
    todo: 0,
    batchesTodo: 0,
    batchesDone: 0
  }
  return context
}

function handle({ context, logger, batchSize = config.blocksBatchSize }) {
  return new Promise(resolve => {
    if (context.blocks.length < 1) {
      resolve()
      return
    }

    context.todo = context.blocks.length
    telemetry.increaseCount('bitswap-total-entries', context.todo)
    telemetry.increaseCount('bitswap-pending-entries', context.todo)
    inspect.metrics.increase('blocks', context.todo)
    inspect.metrics.increase('requests')

    let blocksLength
    context.batchesTodo = Math.ceil(context.todo / batchSize)
    do {
      const blocks = context.blocks.splice(0, batchSize)

      if (blocks.length === 0) {
        break
      }

      blocksLength = blocks.length
      process.nextTick(async () => {
        // catch asyn error in libp2p connection
        try {
          // state can be 'error' or 'end'
          // in those cases skip fetching and response, iterate pending batches and close
          if (context.state === 'ok') {
            // append content to its block
            const fetched = await batchFetch(blocks, context, logger)
            // close connection on last batch
            await batchResponse({ blocks: fetched, context, logger })
          }
          context.batchesDone++
          if (context.batchesDone === context.batchesTodo) {
            endResponse({ context, logger })
            resolve()
          }
        } catch (err) {
          logger.error({ err: serializeError(err) }, 'error on handler#nextTick')
        }
      })
    } while (blocksLength === batchSize)
  })
}

/**
 * fetch blocks content from storage
 * append content to its block
 */
async function batchFetch(blocks, context, logger) {
  try {
    const dataBlocks = []
    const infoBlocks = []
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]
      const key = cidToKey(block.cid)
      if (!key) {
        logger.error({ block }, 'invalid block cid')
        telemetry.increaseCount('bitswap-block-error')
        continue
      }
      block.key = key

      if (block.wantType === Entry.WantType.Block) {
        block.type = BLOCK_TYPE_DATA
        dataBlocks.push(block)
        continue
      }
      if (block.wantType === Entry.WantType.Have && context.protocol === BITSWAP_V_120) {
        block.type = BLOCK_TYPE_INFO
        infoBlocks.push(block)
        continue
      }

      // other blocks are stripped and not fetched - and not responded
      logger.error({ block }, 'unsupported block type')
      telemetry.increaseCount('bitswap-block-error')
    }

    await Promise.all([
      fetchBlocksInfo({ blocks: infoBlocks, logger, awsClient: context.awsClient }),
      fetchBlocksData({ blocks: dataBlocks, logger, awsClient: context.awsClient })
    ])
    return [...infoBlocks, ...dataBlocks]
  } catch (error) {
    logger.error({ error: serializeError(error) }, 'error on handler#batchFetch')
  }
}

async function batchResponse({ blocks, context, logger }) {
  if (!blocks) { return }

  try {
    if (!context.connection && !context.connecting) {
      context.connecting = connectPeer({ context, logger })
      context.connection = await context.connecting
      context.connection.on('close', () => { endResponse({ context, logger }) })
    }
    await context.connecting
  } catch (error) {
    context.state = 'error'
    // TODO add metric connection-error
    return
  }

  try {
    let message = new Message()
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]

      const size = messageSize[block.type](block)
      // maxMessageSize MUST BE larger than a single block info/data
      if (message.size() + size > config.maxMessageSize) {
        await message.send(context)
        message = new Message()
      }

      message.push(block, size, context.protocol)
      sentMetrics[block.type](block, size)
    }

    await message.send(context)
    context.done += blocks.length
  } catch (error) {
    logger.error({ error: serializeError(error) }, 'error on handler#batchResponse')
  }
}

// end response, close connection
async function endResponse({ context, logger }) {
  if (context.state === 'end') { return }

  context.state = 'end'

  if (context.connection) {
    try {
      await context.connection.close()
      context.connection.removeAllListeners()
    } catch (error) {
      logger.error({ error: serializeError(error) }, 'error on close connection handler#endResponse')
    }
  }

  telemetry.decreaseCount('bitswap-pending-entries', context.todo)
  inspect.metrics.decrease('requests')
  inspect.metrics.decrease('blocks', context.todo)
}

const messageSize = {
  [BLOCK_TYPE_DATA]: (block) => block.data?.content?.length ?? 0,
  [BLOCK_TYPE_INFO]: (block) => sizeofBlockInfo(block.info)
}

// not accurate, not considering fixed overhead
const sentMetrics = {
  [BLOCK_TYPE_DATA]: (block, size) => {
    block.data?.found && telemetry.increaseCount('bitswap-sent-data', size)
  },
  [BLOCK_TYPE_INFO]: (block, size) => {
    block.info?.found && telemetry.increaseCount('bitswap-sent-info', size)
  }
}

module.exports = {
  handle, createContext
}
