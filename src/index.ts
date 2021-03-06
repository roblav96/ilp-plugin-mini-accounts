import * as crypto from 'crypto'
const BtpPacket = require('btp-packet')
import * as WebSocket from 'ws'
import * as assert from 'assert'
import AbstractBtpPlugin, * as BtpPlugin from 'ilp-plugin-btp'
import * as ILDCP from 'ilp-protocol-ildcp'
import * as IlpPacket from 'ilp-packet'
const { Errors } = IlpPacket
const StoreWrapper = require('ilp-store-wrapper')
import OriginWhitelist from './lib/origin-whitelist'
import Token from './token'
import { Store, StoreWrapper } from './types'
const createLogger = require('ilp-logger')
import { IncomingMessage } from 'http'

export { BtpSubProtocol } from 'ilp-plugin-btp'

const DEBUG_NAMESPACE = 'ilp-plugin-mini-accounts'

function tokenToAccount (token: string): string {
  return BtpPacket.base64url(crypto.createHash('sha256').update(token).digest())
}

interface Logger {
  info (...msg: any[]): void
  warn (...msg: any[]): void
  error (...msg: any[]): void
  debug (...msg: any[]): void
  trace (...msg: any[]): void
}

export type Protocol = {
  protocolName: string
  contentType: number
  data: Buffer
}

export interface BtpData {
  data: {
    protocolData: Protocol[]
  }
  requestId: number
}

/* tslint:disable-next-line:no-empty */
function noopTrace (...msg: any[]): void { }

export default class Plugin extends AbstractBtpPlugin {
  static version = 2

  private _wsOpts: WebSocket.ServerOptions
  protected _currencyScale: number
  private _debugHostIldcpInfo?: ILDCP.IldcpResponse
  protected _log: Logger
  private _trace: (...msg: any[]) => void
  private _connections: Map<string, Set<WebSocket>> = new Map()
  private _allowedOrigins: OriginWhitelist
  protected _store?: StoreWrapper

  private _hostIldcpInfo: ILDCP.IldcpResponse
  protected _prefix: string
  // These can be overridden.
  // TODO can this be overridden via `extends`??
  protected _handleCustomData: (from: string, btpPacket: BtpPlugin.BtpPacket) => Promise<BtpPlugin.BtpSubProtocol[]>
  protected _handlePrepareResponse: (destination: string, parsedIlpResponse: IlpPacket.IlpPacket, preparePacket: IlpPacket.IlpPacket) => void

  constructor (opts: {
    port?: number,
    wsOpts?: WebSocket.ServerOptions,
    currencyScale?: number,
    debugHostIldcpInfo?: ILDCP.IldcpResponse,
    allowedOrigins?: string[],
    _store?: Store
  }, { log, store }: {
    log?: Logger,
    store?: Store
  } = {}) {
    super({})
    const defaultPort = opts.port || 3000
    this._wsOpts = opts.wsOpts || { port: defaultPort }
    this._currencyScale = opts.currencyScale || 9
    this._debugHostIldcpInfo = opts.debugHostIldcpInfo

    this._log = log || createLogger(DEBUG_NAMESPACE)
    this._log.trace = this._log.trace || noopTrace

    this._allowedOrigins = new OriginWhitelist(opts.allowedOrigins || [])

    if (store || opts._store) {
      this._store = new StoreWrapper(store || opts._store)
    }
  }

  /* tslint:disable:no-empty */
  // These can be overridden.
  protected async _preConnect (): Promise<void> {}
  // FIXME: right now plugin-btp and plugin-mini-accounts use different signatures
  // for _connect -- ideally mini-accounts would use a different function name, but
  // this is as close as it can get without being a breaking change.
  // @ts-ignore
  protected async _connect (address: string, authPacket: BtpData, opts: {
    ws: WebSocket,
    req: IncomingMessage
  }): Promise<void> {}
  protected async _close (account: string, err?: Error): Promise<void> {}
  protected _sendPrepare (destination: string, parsedPacket: IlpPacket.IlpPacket): void {}
  /* tslint:enable:no-empty */

  ilpAddressToAccount (ilpAddress: string): string {
    if (ilpAddress.substr(0, this._prefix.length) !== this._prefix) {
      throw new Error('ILP address (' + ilpAddress + ') must start with prefix (' + this._prefix + ')')
    }

    return ilpAddress.substr(this._prefix.length).split('.')[0]
  }

  async connect (): Promise<void> {
    if (this._wss) return

    if (this._debugHostIldcpInfo) {
      this._hostIldcpInfo = this._debugHostIldcpInfo
    } else if (this._dataHandler) {
      this._hostIldcpInfo = await ILDCP.fetch(this._dataHandler.bind(this))
    } else {
      throw new Error('no request handler registered')
    }

    this._prefix = this._hostIldcpInfo.clientAddress + '.'

    if (this._preConnect) {
      try {
        await this._preConnect()
      } catch (err) {
        this._log.debug(`Error on _preConnect. Reason is: ${err.message}`)
        throw new Error('Failed to connect')
      }
    }

    this._log.info('listening on port ' + this._wsOpts.port)
    const wss = this._wss = new WebSocket.Server(this._wsOpts)
    wss.on('connection', (wsIncoming, req) => {
      this._log.trace('got connection')
      if (typeof req.headers.origin === 'string' && !this._allowedOrigins.isOk(req.headers.origin)) {
        this._log.debug(`Closing a websocket connection received from a browser. Origin is ${req.headers.origin}`)
        this._log.debug('If you are running moneyd, you may allow this origin with the flag --allow-origin.' +
          ' Run moneyd --help for details.')
        wsIncoming.close()
        return
      }

      let token: string
      let account: string

      const closeHandler = (error?: Error) => {
        this._log.debug('incoming ws closed. error=', error)
        if (account) this._removeConnection(account, wsIncoming)
        if (this._close) {
          this._close(this._prefix + account, error)
            .catch(e => {
              this._log.debug('error during custom close handler. error=', e)
            })
        }
      }

      wsIncoming.on('close', closeHandler)
      wsIncoming.on('error', closeHandler)

      // The first message must be an auth packet
      // with the macaroon as the auth_token
      let authPacket: BtpPlugin.BtpPacket
      wsIncoming.once('message', async (binaryAuthMessage) => {
        try {
          authPacket = BtpPacket.deserialize(binaryAuthMessage)
          assert.strictEqual(authPacket.type, BtpPacket.TYPE_MESSAGE, 'First message sent over BTP connection must be auth packet')
          assert(authPacket.data.protocolData.length >= 2, 'Auth packet must have auth and auth_token subprotocols')
          assert.strictEqual(authPacket.data.protocolData[0].protocolName, 'auth', 'First subprotocol must be auth')
          for (let subProtocol of authPacket.data.protocolData) {
            if (subProtocol.protocolName === 'auth_token') {
              // TODO: Do some validation on the token
              token = subProtocol.data.toString()
              account = account || tokenToAccount(token)
              this._addConnection(account, wsIncoming)
            } else if (subProtocol.protocolName === 'auth_username') {
              if (this._store) {
                account = subProtocol.data.toString()
              }
            }
          }
          assert(token, 'auth_token subprotocol is required')

          this._log.trace('got auth info. token=' + token, 'account=' + account)
          if (this._store) {
            const storedToken = await Token.load({ account, store: this._store })
            const receivedToken = new Token({ account, token, store: this._store })
            if (storedToken) {
              if (!storedToken.equal(receivedToken)) {
                throw new Error('incorrect token for account.' +
                  ' account=' + account +
                  ' token=' + token)
              }
            } else {
              receivedToken.save()
            }
          }

          if (this._connect) {
            await this._connect(this._prefix + account, authPacket, {
              ws: wsIncoming,
              req
            })
          }

          wsIncoming.send(BtpPacket.serializeResponse(authPacket.requestId, []))
        } catch (err) {
          if (authPacket) {
            this._log.debug('not accepted error during auth. error=', err)
            const errorResponse = BtpPacket.serializeError({
              code: 'F00',
              name: 'NotAcceptedError',
              data: err.message || err.name,
              triggeredAt: new Date().toISOString()
            }, authPacket.requestId, [])
            wsIncoming.send(errorResponse) // TODO throws error "not opened"
          }
          wsIncoming.close()
          return
        }

        this._log.trace('connection authenticated')

        wsIncoming.on('message', async (binaryMessage) => {
          let btpPacket
          try {
            btpPacket = BtpPacket.deserialize(binaryMessage)
          } catch (err) {
            wsIncoming.close()
          }
          this._log.trace(`account ${account}: processing btp packet ${JSON.stringify(btpPacket)}`)
          try {
            this._log.trace('packet is authorized, forwarding to host')
            await this._handleIncomingBtpPacket(this._prefix + account, btpPacket)
          } catch (err) {
            this._log.debug('btp packet not accepted', err)
            const errorResponse = BtpPacket.serializeError({
              code: 'F00',
              name: 'NotAcceptedError',
              triggeredAt: new Date().toISOString(),
              data: err.message
            }, btpPacket.requestId, [])
            wsIncoming.send(errorResponse)
          }
        })
      })
    })
  }

  async disconnect () {
    if (this._disconnect) {
      await this._disconnect()
    }

    if (this._wss) {
      const wss = this._wss
      await new Promise((resolve) => wss.close(resolve))
      this._wss = null
    }
  }

  isConnected () {
    return !!this._wss
  }

  async sendData (buffer: Buffer): Promise<Buffer> {
    const parsedPacket = IlpPacket.deserializeIlpPacket(buffer)

    let destination
    let isPrepare = false
    switch (parsedPacket.type) {
      case IlpPacket.Type.TYPE_ILP_PAYMENT:
      case IlpPacket.Type.TYPE_ILP_FORWARDED_PAYMENT:
        destination = parsedPacket.data['account']
        break
      case IlpPacket.Type.TYPE_ILP_PREPARE:
        isPrepare = true
        destination = parsedPacket.data['destination']
        if (this._sendPrepare) {
          this._sendPrepare(destination, parsedPacket)
        }
        break
      case IlpPacket.Type.TYPE_ILQP_LIQUIDITY_REQUEST:
      case IlpPacket.Type.TYPE_ILQP_BY_SOURCE_REQUEST:
      case IlpPacket.Type.TYPE_ILQP_BY_DESTINATION_REQUEST:
        destination = parsedPacket.data['destinationAccount']
        break
      default:
        throw new Error('can\'t route packet with no destination. type=' + parsedPacket.type)
    }

    if (destination === 'peer.config') {
      return ILDCP.serializeIldcpResponse(this._hostIldcpInfo)
    }

    if (!destination.startsWith(this._prefix)) {
      throw new Error(`can't route packet that is not meant for one of my clients. destination=${destination} prefix=${this._prefix}`)
    }

    const response = await this._call(destination, {
      type: BtpPacket.TYPE_MESSAGE,
      requestId: crypto.randomBytes(4).readUInt32BE(0),
      data: { protocolData: [{
        protocolName: 'ilp',
        contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
        data: buffer
      }] }
    })

    const ilpResponse = response.protocolData.filter(p => p.protocolName === 'ilp')[0]
    const parsedIlpResponse = IlpPacket.deserializeIlpPacket(ilpResponse.data)

    if (parsedIlpResponse.type === IlpPacket.Type.TYPE_ILP_FULFILL) {
      const executionCondition = parsedPacket.data['executionCondition'] || Buffer.alloc(0)
      /* tslint:disable-next-line:no-unnecessary-type-assertion */
      const fulfillResponse = parsedIlpResponse.data as IlpPacket.IlpFulfill
      if (!crypto.createHash('sha256')
        .update(fulfillResponse.fulfillment)
        .digest()
        .equals(executionCondition)) {
        return IlpPacket.errorToReject(this._hostIldcpInfo.clientAddress,
          new Errors.WrongConditionError(
            'condition and fulfillment don\'t match. ' +
            `condition=${executionCondition.toString('hex')} ` +
            `fulfillment=${fulfillResponse.fulfillment.toString('hex')}`))
      }
    }

    if (isPrepare && this._handlePrepareResponse) {
      try {
        this._handlePrepareResponse(destination, parsedIlpResponse, parsedPacket)
      } catch (e) {
        return IlpPacket.errorToReject(this._hostIldcpInfo.clientAddress, e)
      }
    }

    return ilpResponse
      ? ilpResponse.data
      : Buffer.alloc(0)
  }

  protected async _handleData (from: string, btpPacket: BtpPlugin.BtpPacket): Promise<BtpPlugin.BtpSubProtocol[]> {
    const { ilp } = this.protocolDataToIlpAndCustom(btpPacket.data)

    if (ilp) {
      const parsedPacket = IlpPacket.deserializeIlpPacket(ilp)

      if (parsedPacket.data['destination'] === 'peer.config') {
        this._log.trace('responding to ILDCP request. clientAddress=%s', from)
        return [{
          protocolName: 'ilp',
          contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
          data: await ILDCP.serve({
            requestPacket: ilp,
            handler: () => ({
              ...this._hostIldcpInfo,
              clientAddress: from
            }),
            serverAddress: this._hostIldcpInfo.clientAddress
          })
        }]
      }
    }

    if (this._handleCustomData) {
      this._log.trace('passing non-ILDCP data to custom handler')
      return this._handleCustomData(from, btpPacket)
    }

    if (!ilp) {
      this._log.debug('invalid packet, no ilp protocol data. from=%s', from)
      throw new Error('invalid packet, no ilp protocol data.')
    }

    if (!this._dataHandler) {
      throw new Error('no request handler registered')
    }

    const response = await this._dataHandler(ilp)
    return this.ilpAndCustomToProtocolData({ ilp: response })
  }

  protected async _handleOutgoingBtpPacket (to: string, btpPacket: BtpPlugin.BtpPacket) {
    if (!to.startsWith(this._prefix)) {
      throw new Error(`invalid destination, must start with prefix. destination=${to} prefix=${this._prefix}`)
    }

    const account = this.ilpAddressToAccount(to)
    const connections = this._connections.get(account)

    if (!connections) {
      throw new Error('No clients connected for account ' + account)
    }

    Array.from(connections).map(wsIncoming => {
      const result = new Promise(resolve => wsIncoming.send(BtpPacket.serialize(btpPacket), resolve))

      result.catch(err => {
        const errorInfo = (typeof err === 'object' && err.stack) ? err.stack : String(err)
        this._log.debug('unable to send btp message to client: ' + errorInfo, 'btp packet:', JSON.stringify(btpPacket))
      })
    })
  }

  private _addConnection (account: string, wsIncoming: WebSocket) {
    let connections = this._connections.get(account)
    if (!connections) {
      this._connections.set(account, connections = new Set())
    }
    connections.add(wsIncoming)
  }

  private _removeConnection (account: string, wsIncoming: WebSocket) {
    const connections = this._connections.get(account)
    if (!connections) return
    connections.delete(wsIncoming)
    if (connections.size === 0) {
      this._connections.delete(account)
    }
  }
}
