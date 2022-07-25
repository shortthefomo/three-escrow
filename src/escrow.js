'use strict'

const cc = require('five-bells-condition')
const crypto = require('crypto')

const { XrplClient } = require('xrpl-client')
const { XummSdk } = require('xumm-sdk')
const lib = require('xrpl-accountlib')

const db = require('./db.js')
const EscrowWatch = require('./escrow_watch.js')
const EscrowBooks = require('./escrow_books.js')
const User = require('./user.js')

const dotenv = require('dotenv')
const debug = require('debug')
const decimal = require('decimal.js')
const log = debug('escrow:logging')
const EventEmitter = require('node:events')

module.exports = class escrow extends EventEmitter {
	constructor(PubSubManager) {
        super()

        dotenv.config()
        const Sdk = new XummSdk(process.env.XUMMAPPKEY, process.env.XUMMAPPSECRET)
		let client = new XrplClient(process.env.XRPL_TESTNET)
        const escrow_books = new EscrowBooks(PubSubManager)
        const escrow_watch = new EscrowWatch(this, escrow_books, PubSubManager)
        const Users = new User()

		Object.assign(this, {
            run() {
                escrow_watch.run()
            },
            async escrowEventNotification(uuid, subtitle, body, data = {}) {
                try {
                    log('user token: ' + uuid)
                    log('event', await Sdk.xApp.event({
                        user_token: uuid,
                        subtitle: subtitle,
                        body: body,
                        data: data
                    }))
                } catch (e) {
                    log('failed to send event notification', e)
                }
			},
            async escrowPushNotification(uuid, subtitle, body, data = {}) {
                try {
                    log('user token: ' + uuid)
                    log('event', await Sdk.xApp.push({
                        user_token: uuid,
                        subtitle: subtitle,
                        body: body,
                        data: data
                    }))
                } catch (e) {
                    log('failed to send push notification', e)
                }
			},
            async createEscrowFulfillment() {
                try {
                    const preimageData = crypto.randomBytes(32)
                    const myFulfillment = new cc.PreimageSha256()
                    myFulfillment.setPreimage(preimageData)
                    const query_conditions = `INSERT HIGH_PRIORITY INTO escrow_conditions(escrow_condition, fulfillment) VALUES (?);`
                    
                    const record_conditions = []
                    record_conditions[0] = myFulfillment.getConditionBinary().toString('hex').toUpperCase()
                    record_conditions[1] = myFulfillment.serializeBinary().toString('hex').toUpperCase()

                    const rows_conditions = await db.query(query_conditions, [record_conditions])
                    if (rows_conditions == undefined) {
                        log('SQL Error')
                        log('query', query_conditions)
                        log('record', record_conditions)
                        return false
                    }
                    return record_conditions[0]
                    
                } catch (error) {
					log('error', error)
				}
                return false
            },
            
            ledgerEpoch() {
                const rippleOffset = 946684800
                const unix_time = Date.now() 
                return Math.floor((unix_time) / 1000) - rippleOffset
            },
            async watchPayments() {
                const self = this
                client.on('ledger', async (event) => {
					const request = {
                        'id': 'xrpl-escrow-watcher',
                        'command': 'ledger',
                        'ledger_hash': event.ledger_hash,
                        'ledger_index': "validated",
                        'transactions': true,
                        'expand': true,
                        'owner_funds': true
                    }
                    const ledger_result = await client.send(request)
                    log(`ledger close... ${ledger_result?.ledger?.ledger_index}`)

                    const transactions = ledger_result?.ledger?.transactions
                    for (let i = 0; i < transactions.length; i++) {
                        const transaction = transactions[i]
                        if (transaction.TransactionType == 'EscrowCreate' && transaction?.metaData?.TransactionResult == 'tesSUCCESS') {
                            log('EscrowCreate', transaction)
                            this.insertCreateEscrowData(ledger_result?.ledger?.ledger_index, transaction)
                        }
                        if (transaction.TransactionType == 'EscrowCancel' && transaction?.metaData?.TransactionResult == 'tesSUCCESS') {
                            log('EscrowCancel', transaction)
                            this.insertCancelEscrowData(transaction)
                        }
                        if (transaction.TransactionType == 'EscrowFinish' && transaction?.metaData?.TransactionResult == 'tesSUCCESS') {
                            log('EscrowFinish', transaction)
                            this.insertFinishEscrowData(transaction)
                        }
                    }
				})
            },
            async insertCancelEscrowData(transaction) {
                if (transaction == undefined) { return false }
                if (!('Memos' in transaction)) { return false }
                if (!('Memo' in transaction.Memos[0])) { return false }
                if (!('MemoData' in transaction.Memos[0].Memo)) { return false }
                let memo = null
                try {
                    memo = Buffer.from(transaction.Memos[0].Memo.MemoData, 'hex').toString('utf8')
                } catch (e) {
                    // log('error', e)
                }
                if (memo != 'Cancelled collateral via three.') { return false }
                log(transaction.TransactionType, transaction)

                let query =`UPDATE escrow_completed engine_result = '${transaction.metaData.TransactionResult}', created = '${new Date().toISOString().slice(0, 19).replace('T', ' ')}' 
                    WHERE hash = '${transaction.hash}';`
                const rows = await db.query(query)
                if (rows == undefined) {
                    log('SQL Error')
                    log('query', query)
                }

                const user_token = await Users.getUserToken(transaction.Owner)
                console.log('user_token', user_token)
                await this.escrowPushNotification(
                    user_token, 
                    'Escrow cancelled', 
                    `Your escrow has been cancelled ${transaction.hash}`,
                    {tx: transaction.hash})

                const escrow = await db.query(`SELECT escrow_conditions.escrow_condition, escrow_completed.hash FROM escrow_completed 
                JOIN escrow_conditions ON (escrow_completed.escrow_condition = escrow_conditions.escrow_condition)
                WHERE escrow_completed.hash = '${transaction.hash}';`)
                console.log('escrow sql', escrow)
                if (escrow == undefined) {
                    log('SQL Error')
                    log('query', escrow)
                }
                if (escrow.length == 1) {
                    if (PubSubManager != null) {
                        // dont send a message if no one is listening
                        if (PubSubManager.checkChannel(transaction.Owner)) {
                            const update = {
                                account: transaction.Owner, 
                                escrow_condition: escrow[0]?.escrow_condition,
                                type: 'EscrowCancel',
                            }
                            log('EscrowCancel pushed', {ESCROW_CLEAR: update})
                            PubSubManager.route({ESCROW_CLEAR: update}, transaction.Owner)
                        }
                    }
                }
            },
            async insertFinishEscrowData(transaction) {
                if (transaction == undefined) { return false }
                if (!('Memos' in transaction)) { return false }
                if (!('Memo' in transaction.Memos[0])) { return false }
                if (!('MemoData' in transaction.Memos[0].Memo)) { return false }
                let memo = null
                try {
                    memo = Buffer.from(transaction.Memos[0].Memo.MemoData, 'hex').toString('utf8')
                } catch (e) {
                    // log('error', e)
                }
                if (memo != 'Finish escrow via three.') { return false }
                log(transaction.TransactionType, transaction)

                let query =`UPDATE escrow_completed engine_result = '${transaction.metaData.TransactionResult}', created = '${new Date().toISOString().slice(0, 19).replace('T', ' ')}' 
                    WHERE hash = '${transaction.hash}';`
                const rows = await db.query(query)
                if (rows == undefined) {
                    log('SQL Error')
                    log('query', query)
                }

                const user_token = await Users.getUserToken(transaction.Owner)
                console.log('user_token', user_token)
                await this.escrowPushNotification(
                    user_token, 
                    'Escrow finished', 
                    `Your escrow has been finished ${transaction.hash}`,
                    {tx: transaction.hash})

                const escrow = await db.query(`SELECT escrow_conditions.escrow_condition, escrow_completed.hash FROM escrow_completed 
                JOIN escrow_conditions ON (escrow_completed.escrow_condition = escrow_conditions.escrow_condition)
                WHERE escrow_completed.hash = '${transaction.hash}';`)
                console.log('escrow sql', escrow)
                if (escrow == undefined) {
                    log('SQL Error')
                    log('query', escrow)
                }
                if (escrow.length == 1) {
                    if (PubSubManager != null) {
                        // dont send a message if no one is listening
                        if (PubSubManager.checkChannel(transaction.Owner)) {
                            const update = {
                                account: transaction.Owner, 
                                escrow_condition: escrow[0]?.escrow_condition,
                                type: 'EscrowFinish',
                            }
                            log('EscrowFinish pushed', {ESCROW_CLEAR: update})
                            PubSubManager.route({ESCROW_CLEAR: update}, transaction.Owner)
                        }
                    }
                }
            },
            async insertCreateEscrowData(ledger, transaction) {
                if (transaction == undefined) { return false }
                log(transaction.TransactionType, transaction)
                if (!('Memos' in transaction)) { return false }
                if (!('Memo' in transaction.Memos[0])) { return false }
                if (!('MemoData' in transaction.Memos[0].Memo)) { return false }
                let memwaa = null
                let memo = null
                try {
                    memwaa = Buffer.from(transaction.Memos[0].Memo.MemoData, 'hex').toString('utf8')
                    memo = JSON.parse(memwaa)
                } catch (e) {
                    // log('error', e)
                }
                if (memo == null) { return false }
                if (!('app' in memo)) { return false }
                if (memo.app != 'panic-bot_loans') { return false }

                const record = []
                record[0] = transaction.Condition
                record[1] = transaction.hash
                record[2] = transaction.Account
                record[3] = transaction.Destination
                record[4] = memo.currency
                record[5] = memo.amount
                record[6] = memo.rate
                record[7] = memo.collateral
                record[8] = (transaction?.DestinationTag != undefined) ? transaction.DestinationTag : null
                record[9] = (transaction?.SourceTag != undefined) ? transaction.SourceTag : null
                record[10] = ledger
                record[11] = memo.issuer
                record[12] = new Date().toISOString().slice(0, 19).replace('T', ' ')
                record[13] = (transaction?.CancelAfter != undefined) ? transaction.CancelAfter : null
                record[14] = (transaction?.FinishAfter != undefined) ? transaction.FinishAfter : null
                record[15] = (transaction?.Sequence != undefined) ? transaction.Sequence : 0
                
                let query =`INSERT HIGH_PRIORITY INTO escrow (escrow_condition, hash, account, destination, currency, amount, rate, collateral, destination_tag, source_tag, ledger, issuer, created, cancel_after, finish_after, sequence) VALUES (?);`
                const rows = await db.query(query, [record])
                if (rows == undefined) {
                    log('SQL Error')
                    log('query', query)
                    log('record', record)
                    log('transaction', transaction)
                }
            },
            async createEscrow(escrow) {
                try {
                    const condition = await this.createEscrowFulfillment()

                    log('amout', escrow.amount)
                    log('collateral', escrow.collateral)
                    const total = decimal.sum(escrow.amount, new decimal(escrow.collateral)).toFixed(10)
                    

                   
                    const rippleOffset = 946684800
                    log('FINISH_AFTER_MIN', process.env.FINISH_AFTER_MIN)
                    // can only fulfill escrow after 1 minute after creation
                    const FinishAfter = Math.floor((new Date().getTime() + (process.env.FINISH_AFTER_MIN * 1)) / 1000) - rippleOffset
                    const CancelAfter = Math.floor(new Date(escrow.cancel_after).getTime() / 1000) - rippleOffset
                    const rate = await escrow_books.currentRate(escrow.amount, escrow.currency, escrow.issuer)
                    
                    const loan_data = {
                        collateral: escrow.collateral,
                        rate: rate,
                        amount: escrow.amount,
                        currency: escrow.currency,
                        issuer: escrow.issuer,
                        app: 'panic-bot_loans',
                        version: '0.0.1'
                    }
                    
                    const memos = [{
                        Memo: {
                            MemoData: Buffer.from(JSON.stringify(loan_data), 'utf-8').toString('hex').toUpperCase(),
                        }
                    }]

                    const EscrowPayload = {
                        'txjson': {
                            Account: escrow.account,
                            TransactionType: 'EscrowCreate',
                            Amount: new decimal((total * rate) * 1_000_000).toFixed(0),
                            Destination: escrow.destination,
                            CancelAfter: CancelAfter,
                            FinishAfter: FinishAfter,
                            Condition: condition,
                            Memos: memos,
                            DestinationTag: 1313,
                            SourceTag: 1313,
                        },
                        custom_meta: {
                            blob: 'Loan collateral via three'
                        }
                    }
                    log('command', EscrowPayload)
                    
                    PubSubManager.route({ ESCROW_CREATE: EscrowPayload }, escrow.account)
                } catch (error) {
					log('error', error)
				}
            },
            async cancelEscrow(offer_sequence, owner, condition) {
                if (offer_sequence == null) { return 'noSequence'}
                let attempts = 1
                let feeBase = 10
                const rippleOffset = 946684800
                const CancelAfter = Math.floor((new Date().getTime()) / 1000) - rippleOffset

                let query =`SELECT * FROM escrow_completed 
                    JOIN escrow ON (escrow.escrow_condition = escrow_completed.escrow_condition)
                    WHERE owner = '${owner}' AND sequence = '${offer_sequence}' AND attempts <= 5 AND cancel_after >= '${CancelAfter}';`
                const completed = await db.query(query)

                if (completed != undefined && completed.length > 0) {    
                    // if its already completed then return
                    if (completed[0]?.engine_result == 'tesSUCCESS') {
                        log('error', 'Escrow already completed')
                        return 'tesSUCCESS'
                    }

                    // if we cant find the escrow then return
                    if (completed[0]?.engine_result == 'tecNO_TARGET') {
                        // log('error', 'Escrow cant be found')
                        return 'tecNO_TARGET'
                    }

                    // up the fee if it failed
                    if (completed[0]?.engine_result == 'telINSUF_FEE_P') {
                        feeBase += (10 * attempts)
                    }

                    if (completed[0]?.attempts) {
                        attempts += 1
                    }
                }

                log('cancelEscrow', completed)

                const { account_data } = await client.send({ command: 'account_info', account: process.env.XRPL_SOURCE_ACCOUNT })
                if (account_data != null && 'Sequence' in account_data) {
                    
                    const memos = [{
                        Memo: {
                            MemoData: Buffer.from('Cancelled collateral via three.', 'utf-8').toString('hex').toUpperCase(),
                        }
                    }]

                    const Tx = {
                        Account: process.env.XRPL_SOURCE_ACCOUNT,
                        TransactionType: 'EscrowCancel',
                        Owner: owner,
                        OfferSequence: offer_sequence,
                        Sequence: account_data.Sequence,
                        Fee: feeBase.toString(),
                        Memos: memos
                    }


                    const keypair = lib.derive.familySeed(process.env.XRPL_SOURCE_ACCOUNT_SECRET)
                    log('Tx', {Tx})
                    const {signedTransaction} = lib.sign(Tx, keypair)
                    log('cancelEscrow signedTransaction', {signedTransaction})
                    const Signed = await client.send({ command: 'submit', 'tx_blob': signedTransaction })
                    log('cancelEscrow', {Signed})

                    const record = []
                    record[0] = (Signed.tx_json?.hash != undefined) ? Signed.tx_json?.hash : null
                    record[1] = condition
                    record[2] = Signed.engine_result
                    record[3] = new Date().toISOString().slice(0, 19).replace('T', ' ')
                    record[4] = Signed.tx_json?.Owner
                    record[5] = Signed.tx_json?.Fee
                    record[6] = offer_sequence
                    record[7] = 'EscrowCancel'
                    
                    
                    let query =`INSERT HIGH_PRIORITY INTO escrow_completed (hash, escrow_condition, engine_result, created, owner, fee, sequence, transaction_type) VALUES (?) ON DUPLICATE KEY UPDATE attempts = '${attempts}', fee = '${feeBase}', engine_result = '${Signed.engine_result}', created = '${new Date().toISOString().slice(0, 19).replace('T', ' ')}';`
                    const rows = await db.query(query, [record])
                    if (rows == undefined) {
                        log('SQL Error')
                        log('query', query)
                        log('record', record)
                    }

                    switch (Signed.engine_result) {
                        case 'tesSUCCESS':
                            // all done
                            break
                        case 'tecNO_TARGET': 
                            // cant find escrow
                            break
                        case 'telINSUF_FEE_P':
                            // not enough fee
                            break
                        case 'tecCRYPTOCONDITION_ERROR':
                            // invalid Fulfillment supplied
                            break
                        case 'tecNO_PERMISSION':
                            // no permission to finish escrow
                            break
                    }
                    return Signed.engine_result
                }
                return false
            },
            async finishEscrow(data) {
                let feeBase = 350
                let attempts = 1
                let query =`SELECT * FROM escrow_completed WHERE owner = '${data.account}' AND escrow_condition = '${data.escrow_condition}' AND attempts <= 5;`
                const completed = await db.query(query)
                
                const rippleOffset = 946684800
                const FinishAfter = Math.floor((new Date().getTime() - (process.env.FINISH_AFTER_MIN * 1)) / 1000) - rippleOffset

                // make sure the escrow can be finished.
                query = `SELECT escrow_conditions.fulfillment, escrow_conditions.escrow_condition FROM escrow_conditions 
                    JOIN escrow ON (escrow.escrow_condition = escrow_conditions.escrow_condition)
                    WHERE escrow.escrow_condition = '${data.escrow_condition}' AND finish_after <= '${FinishAfter}';`
                
                const escrow = await db.query(query)
                // log('finishEscrow lookup ', completed)

                if (escrow == undefined || escrow.length == 0) {
                    // log('error', 'Escrow not found')
                    // log('query', query)
                    return 'escrowNotFound'
                }

                if (completed != undefined && completed.length > 0) {    
                    // if its already completed then return
                    if (completed[0]?.engine_result == 'tesSUCCESS') {
                        log('error', 'Escrow already completed')
                        return 'tesSUCCESS'
                    }

                    // if we cant find the escrow then return
                    if (completed[0]?.engine_result == 'tecNO_TARGET') {
                        log('error', 'Escrow cant be found')
                        return 'tecNO_TARGET'
                    }

                    // up the fee if it failed
                    if (completed[0]?.engine_result == 'telINSUF_FEE_P') {
                        feeBase += (10 * attempts)
                    }

                    if (completed[0]?.attempts) {
                        attempts += 1
                    }
                }

                const { account_data } = await client.send({ command: 'account_info', account: process.env.XRPL_SOURCE_ACCOUNT })
                if (account_data != null && 'Sequence' in account_data) {
                    const memos = [{
                        Memo: {
                            MemoData: Buffer.from(`Finish escrow via three.`, 'utf-8').toString('hex').toUpperCase(),
                        }
                    }]

                    const Tx = {
                        Account: process.env.XRPL_SOURCE_ACCOUNT,
                        TransactionType: 'EscrowFinish',
                        Owner: data.account,
                        OfferSequence: data.sequence,
                        Sequence: account_data.Sequence,
                        Fee: feeBase.toString(),
                        Condition: data.escrow_condition,
                        Fulfillment: escrow[0]?.fulfillment,
                        Memos: memos
                    }

                    log('finishTx', Tx)

                    const keypair = lib.derive.familySeed(process.env.XRPL_SOURCE_ACCOUNT_SECRET)
                    const {signedTransaction} = lib.sign(Tx, keypair)
                    log('finishEscrow signedTransaction', {signedTransaction})
                    const Signed = await client.send({ command: 'submit', 'tx_blob': signedTransaction })

                    log('finishEscrow', {Signed})

                    const record = []
                    record[0] = (Signed.tx_json?.hash != undefined) ? Signed.tx_json?.hash : null
                    record[1] = Signed.tx_json?.Condition
                    record[2] = Signed.engine_result
                    record[3] = new Date().toISOString().slice(0, 19).replace('T', ' ')
                    record[4] = Signed.tx_json?.Owner
                    record[5] = Signed.tx_json?.Fee
                    record[6] = data.sequence
                    record[7] = 'EscrowFinish'
                    
                    let query =`INSERT HIGH_PRIORITY INTO escrow_completed (hash, escrow_condition, engine_result, created, owner, fee, sequence, transaction_type) VALUES (?) ON DUPLICATE KEY UPDATE attempts = '${attempts}', fee = '${feeBase}', engine_result = '${Signed.engine_result}', created = '${new Date().toISOString().slice(0, 19).replace('T', ' ')}';`
                    const rows = await db.query(query, [record])
                    if (rows == undefined) {
                        log('SQL Error')
                        log('query', query)
                        log('record', record)
                    }

                    switch (Signed.engine_result) {
                        case 'tesSUCCESS':
                            // all done
                            break
                        case 'tecNO_PERMISSION':
                            // not allowed... queue for later
                            break;
                        case 'tecNO_TARGET': 
                            // cant find escrow its completed
                            break
                        case 'telINSUF_FEE_P':
                            // not enough fee
                            break
                        case 'tecCRYPTOCONDITION_ERROR':
                            // invalid Fulfillment supplied
                            break
                    }
                    return Signed.engine_result
                }
            }
		})
	}
}