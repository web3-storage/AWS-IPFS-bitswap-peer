'use strict'

const { NOISE } = require('@chainsafe/libp2p-noise')
const libp2p = require('libp2p')
const Multiplex = require('libp2p-mplex')
const Websockets = require('libp2p-websockets')
const LRUCache = require('mnemonist/lru-cache')
const pMap = require('p-map')
const { cacheBlocksInfo, concurrency, blocksTable, getPeerId, primaryKeys, port } = require('./config')
const { logger, serializeError } = require('./logging')
const {
  BITSWAP_V_120,
  Block,
  BlockPresence,
  Entry,
  Message,
  protocols,
  emptyWantList,
  maxBlockSize
} = require('./protocol')
const { Connection } = require('./networking')
const { cidToKey, fetchS3Object, readDynamoItem } = require('./storage')
const { metrics } = require('./telemetry')

const blocksCache = new LRUCache(1e6)

function createEmptyMessage(blocks = [], presences = []) {
  return new Message(emptyWantList, blocks, presences, 0)
}

async function getBlockInfo(cid) {
  const key = cidToKey(cid)
  const cached = blocksCache.get(key)

  if (cacheBlocksInfo && cached) {
    return cached
  }

  const item = await readDynamoItem(blocksTable, primaryKeys.blocks, key)

  if (item) {
    blocksCache.set(key, item)
  }

  return item
}

async function fetchBlock(cid) {
  const info = await getBlockInfo(cid)

  if (!info) {
    return null
  }

  const { offset, length, car } = info.cars[0]

  if (length > maxBlockSize) {
    return null
  }

  const separator = car.indexOf('/')
  const bucket = car.slice(0, separator)
  const key = car.slice(separator + 1)

  return fetchS3Object(bucket, key, offset, length)
}

async function sendMessage(context, message) {
  if (!context.connection) {
    const dialConnection = await context.service.dial(context.peer)
    const { stream } = await dialConnection.newStream(context.protocol)
    context.connection = new Connection(stream)
  }

  metrics.bitSwapTotalConnections.add(1)
  metrics.bitSwapActiveConnections.add(1)
  context.connection.send(message.encode(context.protocol))
}

async function processWantlist(wantlist, context) {
  let message = createEmptyMessage()
  metrics.bitSwapTotalEntries.add(wantlist.entries.length)
  metrics.bitSwapPendingEntries.add(wantlist.entries.length)

  // For each entry in the list
  await pMap(
    wantlist.entries,
    async entry => {
      // We don't care about canceling wantlist since we don't maintain state
      if (entry.cancel) {
        return
      }

      let newBlock
      let newPresence

      if (entry.wantType === Entry.WantType.Block) {
        // Fetch the block and eventually append to the list of blocks
        const raw = await fetchBlock(entry.cid)

        if (raw) {
          metrics.bitSwapBlockHits.add(1)
          metrics.bitSwapSentData.add(raw.length)
          newBlock = new Block(entry.cid, raw)
        } else if (entry.sendDontHave && context.protocol === BITSWAP_V_120) {
          metrics.bitSwapBlockMisses.add(1)
          newPresence = new BlockPresence(entry.cid, BlockPresence.Type.DontHave)
        }
      } else if (entry.wantType === Entry.WantType.Have && context.protocol === BITSWAP_V_120) {
        // Check if we have the block
        const existing = await getBlockInfo(entry.cid)

        if (existing) {
          metrics.bitSwapBlockHits.add(1)
          newPresence = new BlockPresence(entry.cid, BlockPresence.Type.Have)
        } else if (entry.sendDontHave) {
          metrics.bitSwapBlockMisses.add(1)
          newPresence = new BlockPresence(entry.cid, BlockPresence.Type.DontHave)
        }
      }

      /*
        In the if-else below, addBlock and addPresence returns false if adding
        the element would make the serialized message exceed the maximum allowed size.

        In that case, we send the message without the new element and prepare a new message.
      */
      if (newBlock) {
        if (!message.addBlock(newBlock, context.protocol)) {
          await sendMessage(context, message)
          message = createEmptyMessage([newBlock])
        }
      } else if (newPresence) {
        if (!message.addBlockPresence(newPresence, context.protocol)) {
          await sendMessage(context, message)
          message = createEmptyMessage([], [newPresence])
        }
      }
    },
    { concurrency }
  )

  metrics.bitSwapPendingEntries.add(-wantlist.entries.length)

  // Once we have processed all blocks, see if there is anything else to send
  if (message.blocks.length || message.blockPresences.length) {
    await sendMessage(context, message)
  }

  if (context.connection) {
    metrics.bitSwapActiveConnections.add(-1)
    await context.connection.close()
  }
}

async function startService(currentPort) {
  const peerId = await getPeerId()

  if (!currentPort) {
    currentPort = port
  }

  const service = await libp2p.create({
    peerId,
    addresses: {
      listen: [`/ip4/0.0.0.0/tcp/${currentPort}/ws`]
    },
    modules: {
      transport: [Websockets],
      streamMuxer: [Multiplex],
      connEncryption: [NOISE]
    }
  })

  service.handle(protocols, async ({ connection: dial, stream, protocol }) => {
    const connection = new Connection(stream)

    // Open a send connection to the peer
    connection.on('data', data => {
      let message

      try {
        message = Message.decode(data, protocol)
      } catch (error) {
        logger.error({ error }, `Invalid data received: ${serializeError(error)}`)
        service.emit('error:receive', error)
        return
      }

      processWantlist(message.wantlist, { service, peer: dial.remotePeer, protocol })
    })

    /* c8 ignore next 4 */
    connection.on('error', error => {
      logger.error({ error }, `Connection error: ${serializeError(error)}`)
      service.emit('error:connection', error)
    })
  })

  service.connectionManager.on('peer:connect', connection => {
    metrics.bitSwapTotalConnections.add(1)
    metrics.bitSwapActiveConnections.add(1)
  })

  service.connectionManager.on('peer:disconnect', connection => {
    metrics.bitSwapActiveConnections.add(-1)
  })

  await service.start()

  logger.info(
    { address: service.transportManager.getAddrs() },
    `BitSwap peer started with PeerId ${service.peerId} and listening on port ${currentPort} ...`
  )

  return { service, port: currentPort, peerId }
}

module.exports = { startService }
