'use strict'

const db = require('./db.js')

const { XrplClient } = require('xrpl-client')
const dotenv = require('dotenv')
const debug = require('debug')
const log = debug('escrow:watch')
const EventEmitter = require('node:events')
const decimal = require('decimal.js')

module.exports = class escrow_books extends EventEmitter {
	constructor(PubSubManager) {
        super()

        dotenv.config()
        const nodes = process.env.XRPL_MAINNET.split(',')
        let client = new XrplClient(nodes)
        let ledger_errors = 0

		Object.assign(this, {
            run() {
                this.listenOffers()
                this.pollingBookOffers()
            },
            pollingBookOffers() {
                this.emit('fetch_books')
            },
            async currentRate(amount, currency, issuer) {
                const hex_currency = this.currencyUTF8ToHex(currency)
                const book_offers = await this.fetchBook(hex_currency, issuer)
                if (book_offers.asks == undefined || book_offers.bids == undefined) { return }
                const data = this.mutateData(book_offers, process.env.XRPL_SOURCE_ACCOUNT)
                const liquidity = this.liquidityCheckAsks(process.env.XRPL_SOURCE_ACCOUNT, amount, hex_currency, issuer, data, book_offers.ledger, false)

                return new decimal(1).div(liquidity.last).toFixed()
            },
            currencyUTF8ToHex(code){
                if(/^[a-zA-Z0-9\?\!\@\#\$\%\^\&\*\<\>\(\)\{\}\[\]\|\]\{\}]{3}$/.test(code))
                    return code

                if(/^[A-Z0-9]{40}$/.test(code))
                    return code

                let hex = ''

                for(let i=0; i<code.length; i++){
                    hex += code.charCodeAt(i).toString(16)
                }

                return hex
                    .toUpperCase()
                    .padEnd(40, '0')
            },
            async fetchBook(currency, issuer) {
                const hex_currency = this.currencyUTF8ToHex(currency)

                if (ledger_errors > 10) {
                    log('ledger errors: ' + ledger_errors)
                    client.reinstate({forceNextUplink: true})
                    log('reinstate client', await client.send({ command: "server_info" }))
                    ledger_errors = 0
                }
                const bids_books = {
                    'id': 4,
                    'command': 'book_offers',
                    'taker': process.env.XRPL_SOURCE_ACCOUNT,
                    'taker_gets': {'currency': hex_currency, 'issuer': issuer },
                    'taker_pays': {'currency': 'XRP' },
                    'limit': 100
                }

                const asks_books = {
                    'id': 3,
                    'command': 'book_offers',
                    'taker': process.env.XRPL_SOURCE_ACCOUNT,
                    'taker_gets': {'currency': 'XRP' },
                    'taker_pays': {'currency': hex_currency, 'issuer': issuer },
                    'limit': 100
                }

                const book_result = await Promise.all([
                    client.send(bids_books),
                    client.send(asks_books)
                ])

                if ('error' in book_result[0]) {
                    log(`error ${ledger_errors}`, book_result)
                    if (book_result[0].error == 'noNetwork') {
                        ledger_errors++
                    }
                    return book_result
                }
                if ('error' in book_result[1]) {
                    log(`error ${ledger_errors}`, book_result)
                    if (book_result[1].error == 'noNetwork') {
                        ledger_errors++
                    }
                    return book_result
                }

                const book_offers = {
                    'bids': book_result[0]?.offers,
                    'asks': book_result[1]?.offers,
                    'ledger': book_result[0]?.ledger_current_index
                }
                return book_offers
            },
            listenOffers() {
                const self = this
                const worker = async (currency, issuer) => {
                    const rippleOffset = 946684800
                    const FinishAfter = Math.floor((new Date().getTime() - (process.env.FINISH_AFTER_MIN * 1)) / 1000) - rippleOffset
                    
                    const query =`SELECT escrow.sequence, escrow.escrow_condition, escrow.account, escrow.amount, escrow.rate, cancel_after, escrow.collateral, escrow.finish_after FROM escrow 
                        LEFT JOIN escrow_completed ON (escrow.escrow_condition = escrow_completed.escrow_condition)
                        WHERE ((escrow_completed.engine_result != 'tesSUCCESS' AND escrow_completed.engine_result != 'tecNO_TARGET') OR escrow_completed.engine_result IS NULL)
                        AND currency = '${currency}' 
                        AND issuer = '${issuer}';`

                    const rows = await db.query(query)
                
                    if (rows == undefined || rows.length == 0) {
                        return 
                    }

                    const book_offers = await self.fetchBook(currency, issuer)
                    
                    if (book_offers.asks == undefined || book_offers.bids == undefined) { return }
                    for (let index = 0; index < rows.length; index++) {
                        const element = rows[index]
                        const data = this.mutateData(book_offers, element.account)
                        // const asks_liquidity = self.liquidityCheckAsks(element.account, element.amount, currency, issuer, data, book_offers.ledger)
                        const bids_liquidity = self.liquidityCheckBids(element.account, element.amount, currency, issuer, data, book_offers.ledger, false)
                        // log(`liquidityCheckAsks`, asks_liquidity)
                        // log(`liquidityCheckBids`, bids_liquidity)
                        
                        const liquidity_call = new decimal(1).div(bids_liquidity.last).mul(decimal.sum(element.amount, element.collateral)).toFixed() 
                        const liquidity_base = new decimal(element.rate).mul(element.amount).toFixed() 
                        

                        const rate_update = {
                            sequence: element.sequence, 
                            account: element.account, 
                            escrow_condition: element.escrow_condition,
                            ledger: book_offers.ledger,
                            liquidity_call: liquidity_call,
                            liquidity_base: liquidity_base,
                            current_rate: new decimal(bids_liquidity.last).toFixed(),
                            original_rate: new decimal(1).div(element.rate).toFixed(),
                            capital: decimal.sum(element.amount, element.collateral).mul(new decimal(element.rate)),
                            amount: element.amount,
                            currency: currency,
                            issuer: issuer,
                            cancel_after: element.cancel_after,
                            collateral: element.collateral,
                            orders_crossed: bids_liquidity.orders_crossed,
                            detail: bids_liquidity
                        }
                        if ((liquidity_call < liquidity_base ) && (FinishAfter >= element.finish_after)) {
                            log(`Yup liquidate it, FinishAfter: ${FinishAfter}, finish_after: ${element.finish_after}`)
                            this.emit('finishEscrow', rate_update)
                        }
                        if (PubSubManager != null) {
                            // dont send a message if no one is listening
                            if (PubSubManager.checkChannel(element.account)) {
                                log('pushed ', {RATE_UPDATE: rate_update})
                                PubSubManager.route({RATE_UPDATE: rate_update}, element.account)
                            }
                        }
                    }
                }
                
                this.addListener('fetch_books', async () => {
                    const query =`SELECT currency, issuer FROM escrow 
                        LEFT JOIN escrow_completed ON (escrow.escrow_condition = escrow_completed.escrow_condition)
                        WHERE ((escrow_completed.engine_result != 'tesSUCCESS' AND escrow_completed.engine_result != 'tecNO_TARGET') OR escrow_completed.engine_result IS NULL)
                        AND currency IS NOT NULL 
                        AND issuer IS NOT NULL
                        GROUP BY currency, issuer;`
                    const rows = await db.query(query)
                    
                    if (rows != undefined && rows.length > 0) {
                        log(`fetching.. ${rows.length} books`)
                        for (let index = 0; index < rows.length; index++) {
                            const element = rows[index]
                            await worker(element.currency, element.issuer)
                        }
                    }

                    await self.pauseFetch()
                    self.pollingBookOffers()
                })
            },
            liquidityCheckAsks(account, amount, currency, issuer, data, ledger, amount_xrp = false) {
                const asks = Object.entries(data.asks)

                let liquidity = 0
                let min_price = 0
                let slippage = 0
                let count = 0
                let first = asks[0][1].limit_price
                while(asks.length > 0) {
                    count++
                    const element = asks.shift()
                    liquidity = decimal.sum(liquidity, new decimal(element[1].amount).mul(element[1].limit_price).toFixed())
                    min_price = element[1].limit_price
                    slippage = new decimal(first).sub(element[1].limit_price).toFixed()
                    if (amount_xrp == false && liquidity >= amount)
                    break

                    if (amount_xrp == true && liquidity >= (new decimal(amount).div(1_000_000).toFixed()))
                    break
                }
                return {
                    'account': account,
                    'currency': currency,
                    'issuer': issuer,
                    'ledger': ledger,
                    'liquidity': liquidity,
                    'liquidity_needed': (amount_xrp == false) ? amount : new decimal(amount).div(1_000_000).toFixed(),
                    'first': first,
                    'last': min_price,
                    'slippage': slippage,
                    'orders_crossed': count
                }
            },
            liquidityCheckBids(account, amount, currency, issuer, data, ledger, amount_xrp = true) {
                const bids = Object.entries(data.bids)

                let liquidity = 0
                let min_price = 0
                let slippage = 0
                let count = 0
                let first = bids[0][1].limit_price
                while(bids.length > 0) {
                    count++
                    const element = bids.shift()
                    liquidity = decimal.sum(liquidity, new decimal(element[1].amount).mul(element[1].limit_price).toFixed())
                    min_price = element[1].limit_price
                    slippage = new decimal(first).sub(element[1].limit_price).toFixed()
                    if (amount_xrp == false && liquidity >= amount)
                    break

                    if (amount_xrp == true && liquidity >= (new decimal(amount).div(1_000_000).toFixed()))
                    break
                }
                return {
                    'account': account,
                    'currency': currency,
                    'issuer': issuer,
                    'ledger': ledger,
                    'liquidity': liquidity,
                    'liquidity_needed': (amount_xrp == false) ? amount : new decimal(amount).div(1_000_000).toFixed(),
                    'first': first,
                    'last': min_price,
                    'slippage': slippage,
                    'orders_crossed': count
                }
            },
            mutateData(data, account) {
                const results = {
                    bids: {},
                    asks: {}
                }

                for (let index = 0; index < data.bids.length; index++) {
                    const offer = data.bids[index]
                    
                    if ('Expiration' in offer && offer.Expiration < this.ledgerEpoch()) { continue }
                    if (offer.account == account) { continue }

                    const price = 1 / ((offer.TakerPays / 1_000_000) / offer.TakerGets.value)
                    const volume = ('taker_pays_funded' in offer && (offer.taker_pays_funded * 1 > 0)) ? offer.taker_pays_funded / 1_000_000 : offer.TakerPays / 1_000_000
                    if (price in results.bids) {
                        results.bids[price].amount += volume
                        continue
                    }
                    results.bids[price] = {
                        amount: volume,
                        limit_price: price
                    }
                }
            
                for (let index = 0; index < data.asks.length; index++) {
                    const offer = data.asks[index]
                    if ('Expiration' in offer && offer.Expiration < this.ledgerEpoch()) { continue }
                    if (offer.account == account) { continue }

                    const price = 1 / ((offer.TakerGets / 1_000_000) / offer.TakerPays.value)
                    const volume = ('taker_gets_funded' in offer) ? offer.taker_gets_funded / 1_000_000 : offer.TakerGets / 1_000_000
                    if (price in results.asks) {
                        results.asks[price].amount += volume
                        continue
                    }
                    results.asks[price] = {
                        amount: volume,
                        limit_price: price
                    }
                
                }
                return results
            },
            pauseFetch(milliseconds = 5000) {
                return new Promise(resolve => {setTimeout(resolve, milliseconds)})
            },
            ledgerEpoch() {
                const unix_time = Date.now() 
                return Math.floor((unix_time) / 1000) - 946684800
            },
		})
	}
}