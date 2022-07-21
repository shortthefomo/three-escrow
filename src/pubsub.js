'use strict'
const EventEmitter = require('events')

const debug = require('debug')
const log = debug('escrow:pubsub')


module.exports = class PubSubManager extends EventEmitter {
	constructor() {
		super()

		const self = this

		let channels = {
		}

		Object.assign(this, {
			checkChannel(account) {
                if (account in channels) { return true }			
				return false
			},
			channelPrivate(account) {
                if (account in channels) { return true }
				channels[account] = {
                    message: [],
                    subscribers: []
                }
				
				return true
			},
			hasChannelSubscribers(channel) {
				if (channel in channels) { 
					if (channels[channel].subscribers.length > 0) {
						return true
					}
				}
				return false
			},
			subscribe(subscriber, channel) {
				try {
					channels[channel].subscribers.push(subscriber)
				} catch (error) {
					// console.log('error', 'trying to join channel: ' + channel)
				}
			},
			removeBroker() {
				//clearInterval(this.brokerId);
			},
			publish(channel, message) {
				try {
					if (channel in channels) {
						channels[channel].message.push(message)
					}
					else {
						log('no channel', channel)
					}
				} catch (error) {
					console.log(error)
				}
			},
			active_channels() {
				// when clients fall off remove them from the subscriber list
				for (const channel in channels) {
					if (channels.hasOwnProperty(channel)) {
						const channelObj = channels[channel]
						if (channelObj.subscribers.length > 0) {
							channelObj.subscribers.forEach((subscriber, index) => {
								if (subscriber._closeFrameSent == true) {
									channels[channel].subscribers.splice(index, 1)
								}
							})
						}
					}
				}
			},
			broker() {
				const self = this
				for (const channel in channels) {
					if (channels.hasOwnProperty(channel)) {
						const channelObj = channels[channel]

						if (channelObj.subscribers.length > 0) {
							if (channelObj.message) {
								channelObj.subscribers.forEach(subscriber => {
									for (var i = 0; i < channelObj.message.length; i++) {
										const string =  JSON.stringify(channelObj.message[i])
										subscriber.send('{"' + channel +'": ' + string + '}')
									}
								})
                            }
						}
                        channelObj.message = []
					}
				}
			},
			route(message, channel) {
				this.publish(channel, message)
			},
			setup() {
				// Listen for our event and dispatch its process
				this.addListener('broker', function() {
					// this.active_channels()
					this.broker()
				})
			},
			start() {
				this.setup()
				// This thing needs to burn a hole in the sun.
				setInterval(() => {
					self.emit('broker', true)
				}, 100)
			}
		})
	}
}