'use strict'
/* global angular XMLHttpRequest pow_initiate pow_callback Paho RAI Rai */
angular.module('canoeApp.services')
  .factory('raiblocksService', function ($log, configService, platformInfo, storageService, lodash) {
    var root = {}

    // This is where communication happens. This service is mostly called from profileService.
    // We use either XMLHttpRpc calls via rai (RaiblocksJS modified) or MQTT-over-WSS.

    // Both profileService and this service holds onto it
    root.wallet = null

    // var host = 'http://localhost:7076' // for local testing against your own rai_wallet or node
    // var host = 'https://getcanoe.io/rpc' // for the alpha
    var host = 'https://getcanoe.io/rpc-dev' // for dev
    var port = 443
    var rai = null

    // port and ip to use for MQTT-over-WSS
    var mqttHost = 'getcanoe.io'
    var mqttPort = 1884
    var mqttClient = null
    var mqttUsername = null

    // See generatePoW below
    var powWorkers = null

    // Let's call it every second
    setTimeout(generatePoW, 1000)

    // For testing, every 60 sec
    // setTimeout(fetchPendingBlocks, 1000)

    // This function calls itself every sec. It can also be called explicitly.
    function generatePoW () {
      // No wallet, no dice
      if (root.wallet === null) {
        return setTimeout(generatePoW, 1000)
      }
      var pool = root.wallet.getWorkPool()
      var hash = false
      // Do we have work to do?
      if (pool.length > 0) {
        // Find one to work on
        for (let i in pool) {
          if (pool[i].needed) {
            hash = pool[i].hash
            break
          }
        }
        if (hash === false) {
          // No hash to work on
          return setTimeout(generatePoW, 1000)
        }
        // Do work server or client side?
        if (configService.getSync().wallet.serverSidePoW) {
          // Server side
          $log.log('Working on server for ' + hash)
          rai.work_generate_async(hash, function (work) {
            $log.log('Server side PoW found for ' + hash + ': ' + work)
            root.wallet.updateWorkPool(hash, work)
            // Now we can do one more, keeping it one at a time for server side
            setTimeout(generatePoW, 1000)
          })
        } else {
          // Client side
          powWorkers = pow_initiate(NaN, 'raiwallet/') // NaN = let it find number of threads
          pow_callback(powWorkers, hash, function () {
            $log.log('Working on client for ' + hash)
          }, function (work) {
            $log.log('Client side PoW found for ' + hash + ': ' + work)
            root.wallet.updateWorkPool(hash, work)
            setTimeout(generatePoW, 1000)
          })
        }
      } else {
        setTimeout(generatePoW, 1000)
      }
    }

    // Whenever the wallet is changed we call this
    root.setWallet = function (wallet) {
      root.wallet = wallet
      wallet.setLogger($log)
      // Install callbacks
      wallet.setBroadcastCallback(function (blk) {
        // TODO Should probably also call this on a regular interval
        var hash = root.broadcastBlock(blk)
        if (hash) {
          $log.debug('Succeeded broadcast, removing readyblock: ' + hash)
          wallet.removeReadyBlock(hash)
          root.saveWallet(wallet, function () {})
        }
      })
    }

    // Import all chains for the whole wallet from scratch throwing away local forks we have.
    // If we have extra blocks those are rebroadcasted.
    function resetChains () {
      if (root.wallet) {
        var accountIds = root.wallet.getAccountIds()
        lodash.each(accountIds, function (account) {
          var currentBlocks = root.wallet.getLastNBlocks(account, 99999)
          var hist = rai.account_history(account)
          var hashes = []
          lodash.each(hist, function (blk) {
            hashes.unshift(blk.hash) // Reversing order
          })
          var blocks = rai.blocks_info(hashes)
          root.wallet.enableBroadcast(false)
          // Unfortunately blocks is an object so to get proper order we use hashes
          lodash.each(hashes, function (hash) {
            var block = blocks[hash]
            var blk = root.wallet.createBlockFromJSON(block.contents)
            blk.setAmount(block.amount)
            blk.setAccount(block.block_account)
            blk.setImmutable(true)
            try {
              // First we check if this is a fork and thus adop it if it is
              if (!root.wallet.importForkedBlock(blk, account)) { // Replaces any existing block
                // No fork so we can just import it
                root.wallet.importBlock(blk, account)
              }
              // It was added so remove it from currentBlocks
              lodash.remove(currentBlocks, function (b) {
                return b.getHash(true) === hash
              })
              root.wallet.removeReadyBlock(blk.getHash(true)) // so it is not broadcasted, not necessary
            } catch (e) {
              $log.error(e)
            }
          })
          // Now we add any old blocks and rebroadcast them
          $log.debug('Current blocks not found from server: ' + JSON.stringify(currentBlocks))
          root.wallet.enableBroadcast(true) // Turn back on
          lodash.each(currentBlocks, function (b) {
            root.wallet.addBlockToReadyBlocks(b)
          })
        })
        root.wallet.enableBroadcast(true) // Turn back on
        root.saveWallet(root.wallet, function () {})
      }
    }
    window.fetchPendingBlocks = fetchPendingBlocks
    window.resetChains = resetChains

    // Explicitly ask for pending blocks and fetching them to process them as if
    // they came in live over the rai_node callback
    function fetchPendingBlocks () {
      if (root.wallet) {
        var accountIds = root.wallet.getAccountIds()
        var accountsAndHashes = rai.accounts_pending(accountIds)
        lodash.each(accountsAndHashes, function (hashes, account) {
          var blocks = rai.blocks_info(hashes)
          lodash.each(blocks, function (blk, hash) {
            root.handleIncomingSendBlock(hash, account, blk.block_account, blk.amount)
          })
        })
      }
    }

    // Synchronous call that currently returns hash if it succeeded, null otherwise
    // TODO make async
    root.broadcastBlock = function (blk) {
      var json = blk.getJSONBlock()
      $log.debug('Broadcast block: ' + json)
      var res = rai.process(json)
      $log.debug('Result ' + JSON.stringify(res))
      return res
    }

    root.connect = function () {
      try {
        rai = new Rai(host, port) // connection
        rai.initialize()
      } catch (e) {
        rai = null
        $log.warn('Failed to initialize server connection, no network?', e)
        // Try again
        setTimeout(function () { root.connect() }, 5000)
      }
    }

    root.connect()

    root.fetchServerStatus = function (cb) {
      var xhr = new XMLHttpRequest()
      xhr.open('POST', host, true)
      xhr.send(JSON.stringify({'action': 'canoe_server_status'}))
      xhr.onreadystatechange = processRequest
      function processRequest (e) {
        if (xhr.readyState === 4 && xhr.status === 200) {
          var response = JSON.parse(xhr.responseText)
          cb(null, response)
        }
      }
    }

    root.isValidSeed = function (seedHex) {
      var isValidHash = /^[0123456789ABCDEF]+$/.test(seedHex)
      return (isValidHash && (seedHex.length === 64))
    }

    root.isValidAccount = function (addr, cb) {
      $log.debug('Validating addr: ' + addr)
      if (!addr.startsWith('xrb_')) {
        return false
      }
      return rai.account_validate(addr)
    }

    /*
    root.changeSeed = function (wallet, seed) {
      $log.debug('Changing seed and clearing accounts: ' + seed)
      wallet.seed = seed
      wallet.accounts = {}
      return rai.wallet_change_seed(wallet.id, seed)
    }

    */

    // Send amountRaw (bigInt) from account to addr, using wallet.
    root.send = function (wallet, account, addr, amountRaw) {
      $log.debug('Sending ' + amountRaw + ' from ' + account.name + ' to ' + addr)
      try {
        var blk = wallet.addPendingSendBlock(account.id, addr, amountRaw)
        // var hash = blk.getHash(true)
        // refreshBalances()
        $log.debug('Added send block successfully: ' + blk.getHash(true))
        // addRecentSendToGui({date: 'Just now', amount: amountRaw, hash: hash})
      } catch (e) {
        $log.error('Send failed ' + e.message)
        return false
      }
      return true
    }

    // Create a new wallet
    root.createNewWallet = function (password) {
      var wallet = RAI.createNewWallet(password)
      return wallet
    }

    // Create a corresponding account in the server for this wallet
    root.createServerAccount = function (wallet) {
      $log.debug('Creating server account for wallet ' + wallet.getId())
      var json = rai.create_server_account(wallet.getId(), wallet.getToken(), wallet.getTokenPass())
      if (json.error) {
        throw Error(json.error)
      }
    }

    // Subscribe to our private topics for incoming messages
    root.subscribeForWallet = function (wallet) {
      $log.debug('Subscribing for wallet ' + wallet.getId())
      root.subscribe('wallet/' + wallet.getId() + '/block/#')
    }

    // Create a new wallet given a good password created by the user, and optional seed.
    root.createWallet = function (password, seed, cb) {
      $log.debug('Creating new wallet')
      var wallet = root.createNewWallet(password)
      wallet.createSeed(seed)
      root.createServerAccount(wallet)
      root.connectMQTT(wallet, function (connected) {
        if (connected) {
          root.updateServerMap(wallet)
          root.subscribeForWallet(wallet)
        }
        // We also hold onto it
        root.setWallet(wallet)
        cb(wallet)
      })
    }

    // Loads wallet from local storage using given password
    root.createWalletFromStorage = function (password, cb) {
      $log.debug('Load wallet from local storage')
      storageService.loadWallet(function (err, data) {
        if (err) {
          return cb(err)
        }
        if (!data) {
          return cb('No wallet in local storage')
        }
        root.setWallet(root.createWalletFromData(password, data))
        // Now we can connect
        root.connectMQTT(root.wallet, function (connected) {
          if (connected) {
            root.updateServerMap(root.wallet)
            root.subscribeForWallet(root.wallet)
          }
          cb(null, root.wallet)
        })
      })
    }

    // Loads wallet from data using password
    root.createWalletFromData = function (password, data) {
      var wallet = root.createNewWallet(password)
      return root.loadWalletData(wallet, data)
    }

    // Create a new account in the wallet
    root.createAccount = function (wallet, accountName) {
      $log.debug('Create account in wallet named ' + accountName)
      var account = wallet.createAccount({label: accountName})
      $log.debug('Created account ' + account.id)
      root.updateServerMap(wallet)
      return account
    }

    // Remove an account from the wallet. TODO Do we actually? Or just hide?
    root.removeAccount = function (wallet, account) {
      $log.debug('Remove account in wallet named ' + account.name)
      wallet.removeAccount(account.id)
      $log.debug('Removed account: ' + account.id)
      root.updateServerMap(wallet)
    }

    // Tell server which accounts this wallet has. The server has a map of wallet id -> accounts
    // This needs to be called when a new account is created or one is removed.
    // We also call it whenever we load a wallet from data.
    root.updateServerMap = function (wallet) {
      var ids = wallet.getAccountIds()
      root.publish('wallet/' + wallet.getId() + '/accounts', JSON.stringify(ids), 2, false)
    }

    // Encrypt and store the wallet in localstorage.
    // This should be called on every modification to the wallet.
    root.saveWallet = function (wallet, cb) {
      storageService.storeWallet(wallet.pack(), function () {
        cb(null, wallet)
      })
    }

    // Loads wallet from local storage using current password in wallet
    root.reloadWallet = function (wallet, cb) {
      $log.debug('Reload wallet from local storage')
      storageService.loadWallet(function (data) {
        root.loadWalletData(wallet, data)
        cb(null, wallet)
      })
    }

    // Load wallet with given data using current password in wallet
    root.loadWalletData = function (wallet, data) {
      try {
        wallet.load(data)
      } catch (e) {
        $log.error('Error decrypting wallet. Check that the password is correct.')
        return
      }
      return wallet
    }

    /* ******************************* MQTT ********************************/

    root.publishBlock = function (block) {
      var msg = {account: block.getAccount(), block: block}
      root.publish('broadcast/' + block.getAccount(), JSON.stringify(msg), 2, false)
    }

    root.reconnectMQTT = function (cb) {
      if (mqttUsername) {
        root.disconnect()
        root.connectMQTT(cb)
      }
    }

    root.connectMQTT = function (wallet, cb) {
      mqttUsername = wallet.getToken()
      var mqttPassword = wallet.getTokenPass()
      var mqttClientId = wallet.getId()
      var opts = {userName: mqttUsername, password: mqttPassword, clientId: mqttClientId}
      // Connect to MQTT
      $log.debug('********** CONNECTING MQTT ***********')
      $log.debug('Options: ' + JSON.stringify(opts))
      root.connect(opts, function () {
        $log.debug('********** CONNECTED MQTT ***********')
        if (cb) {
          cb(true)
        }
      }, function (c, code, msg) {
        $log.debug('FAILURE', {context: c, code: code, msg: msg})
        root.disconnect()
        if (cb) {
          cb(false)
        }
      })
    }

    // Are we connected to the MQTT server?
    root.isConnected = function () {
      return mqttClient !== null
    }

    // Disconnects MQTT.
    root.disconnect = function () {
      if (mqttClient) {
        if (mqttClient.end) {
          mqttClient.end()
        }
      }
      mqttClient = null
    }

    root.onConnectionLost = function (responseObject) {
      if (responseObject.errorCode !== 0) {
        $log.info('MQTT connection lost: ' + responseObject.errorMessage)
      }
    }

    root.onFailure = function () {
      $log.info('MQTT failure')
    }

    root.handleIncomingSendBlock = function (hash, account, from, amount) {
      // Create a receive (or open, if this is the first block in account) block to match
      // this incoming send block
      if (root.wallet.addPendingReceiveBlock(hash, account, from, amount)) {
        // TODO Add something visual for the txn?
        // var txObj = {account: account, amount: bigInt(blk.amount), date: blk.from, hash: blk.hash}
        // addRecentRecToGui(txObj)
        root.saveWallet(root.wallet, function () {})
        generatePoW()
      }
    }

    root.onIncomingBlock = function (blkType, payload) {
      /*
        {
          "account":"xrb_15d4oo67z6ruebmkcjqghawcbf5f9r4zkg8pf1af3n1s7kd9u7x3m47y8x37",
          "hash":"9818A861E6D961F0F94EA19FC1F54D714F076F258F6C2637502AD9FEDA6E83B5",
          "block":"{\n    \"type\": \"send\",\n    \"previous\": \"DBDC7AA21FA059513C7390F8ADB6EAA664384126E64DB50CFE09E31F594CDCFF\",\n    \"destination\": \"xrb_117ikxnfcpoz7oz56sxdw5yhwtt86rrwxsg5io6c6pbqa4fsr1cnyot4ikqu\",\n    \"balance\": \"00000000000000000000000000000000\",\n    \"work\": \"06fa80d5e00f047d\",\n    \"signature\": \"EAAC8136BD133B6A9D5584598558CE45A8A461B50414264B8AF73D04769C4F20E59A8C17C0E2B5C2A4ABD7BD3C980DE69616F93789FF5C5C613F51300A8BFF0A\"\n}\n",
          "amount":"1994000000000000000000000000000"
        }
      */
      // A block
      var blk = JSON.parse(payload)
      var blk2 = JSON.parse(blk.block)
      var from = blk.account
      var hash = blk.hash
      var account = blk2.destination
      var amount = blk.amount
      $log.debug('From: ' + from + 'to: ' + account + ' type: ' + blkType + ' amount: ' + amount)
      // Switch on block type
      switch (blkType) {
        case 'open':
          // TODO We should match it right?  It can only originate from me unless multiple devices
          $log.debug('An open block ignored')
          return
        case 'send':
          return root.handleIncomingSendBlock(hash, account, from, amount)
        case 'receive':
          // TODO We should match it right? It can only originate from me unless multiple devices
          $log.debug('A receive block ignored')
          return
        case 'change':
          // TODO We should match it right? It can only originate from me unless multiple devices
          $log.debug('A change block ignored')
          return
      }
      $log.error('Unknown block type: ' + blkType)
    }

    root.onMessageArrived = function (message) {
      $log.debug('Topic: ' + message.destinationName + ' Payload: ' + message.payloadString)
      var topic = message.destinationName
      var payload = message.payloadString
      // Switch over topics
      var parts = topic.split('/')
      if (parts[0] === 'wallet') {
        // A wallet specific message
        // TODO ensure proper wallet id?
        if (parts[2] === 'block') {
          return root.onIncomingBlock(parts[3], payload)
        }
      }
      $log.debug('Message not handled: ' + topic)
    }

    // Connect to MQTT. callback when connected or failed.
    root.connect = function (options, callback, callbackFailure) {
      var port = mqttPort
      var ip = mqttHost
      var userName = options.userName
      var password = options.password
      var clientId = options.clientId
      root.disconnect()
      mqttClient = new Paho.MQTT.Client(ip, port, clientId)
      mqttClient.onConnectionLost = root.onConnectionLost
      mqttClient.onFailure = root.onFailure
      mqttClient.onMessageArrived = root.onMessageArrived
      var opts = {
        keepAliveInterval: 3600,
        useSSL: true,
        userName: userName,
        password: password,
        onSuccess: callback,
        onFailure: callbackFailure
      }
      mqttClient.connect(opts)
    }

    root.publish = function (topic, json, qos, retained) {
      if (mqttClient) {
        var message = new Paho.MQTT.Message(json)
        message.destinationName = topic
        if (qos !== undefined) {
          message.qos = qos
        }
        if (retained !== undefined) {
          message.retained = retained
        }
        $log.debug('Send ' + topic + ' ' + json)
        mqttClient.send(message)
      } else {
        $log.debug('Should send ' + topic + ' ' + json)
      }
    }

    root.subscribe = function (topic) {
      mqttClient.subscribe(topic)
      $log.debug('Subscribed: ' + topic)
    }

    root.unsubscribe = function (topic) {
      mqttClient.unsubscribe(topic)
      $log.debug('Unsubscribed: ' + topic)
    }

    return root
  })
