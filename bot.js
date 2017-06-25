'use strict';

const
  steem = require("steem"),
  path = require("path"),
  mongodb = require("mongodb"),
  moment = require('moment'),
  S = require('string'),
  wait = require('wait.for');

const
  DB_RECORDS = "records";

const
  RECORDS_FETCH_LIMIT = 100,
  VOTE_POWER_1_PC = 100;

var ObjectID = mongodb.ObjectID;
var db;


// Connect to the database first
mongodb.MongoClient.connect(process.env.MONGODB_URI, function (err, database) {
  if (err) {
    console.log(err);
    process.exit(1);
  }

  db = database;
  console.log("Database connection ready");

  main();
});

function main() {
  console.log("donation-vote-bot waking up");
  steem.config.set('websocket','wss://steemd.steemit.com');
  getLastInfos(function (lastTransactionTimeAsEpoch, lastTransactionNumber) {
    readTransfers(lastTransactionTimeAsEpoch, lastTransactionTimeAsEpoch,
        function (transfers) {
          console.log("*** GOT TRANSFERS ***");
          if (transfers === undefined
             || transfers === null) {
            console.log("Error getting transfers");
            console.log(err, transfers);
          } else {
            console.log("Got "+transfers.length+" transfers");
            console.log(JSON.stringify(transfers));
            // process transactions
            voteOnPosts(transfers, function (err) {
              if (err) {
                console.log("vote on posts had error: "+err);
              } else {
                console.log("*** FINISHED ***")
              }
            });
          }
        });
  });
}

function voteOnPosts(transfers, callback) {
  wait.launchFiber(function() {
    // get steem global properties first, needed for SP calc
    var properties = wait.for(steem_getSteemGlobaleProperties_wrapper);
    // get Steem Power of bot account
    var accounts = wait.for(steem_getAccounts_wrapper);
    var account = accounts[0];
    var botVotingPower = account.voting_power;
    var steemPower = getSteemPowerFromVest(properties, account.vesting_shares);
    console.log("Bot SP is "+steemPower);
    // determine which voting power probability table to use
    var probTable = null;
    for (var i = 0 ; i < votePowerProb_levelSp.length ; i++) {
      if (steemPower >= votePowerProb_levelSp[i]) {
        probTable = votePowerProb_levelTables[i];
      }
    }
    if (probTable === null) {
      callback("Fatal error, probability table could not be determined," +
        " cannot vote");
      return;
    }
    console.log("prob table: "+JSON.stringify(probTable));
    // process transfers, vote on posts
    console.log("processing transfers...");
    for (var i = 0 ; i < transfers.length ; i++) {
      var transfer = transfers[i];
      console.log(" - transfer "+i+": "+JSON.stringify(transfer));
      // calc nearest whole number STEEM amount
      var amountFloor = Math.floor(transfer.number_amount);
      if (amountFloor > probTable[0].length) {
        amountFloor = probTable.length;
      }
      console.log(" - - amountFloor: "+amountFloor);
      // calculate power
      var rnd = Math.random();
      console.log(" - - rnd: "+rnd);
      var cumulativeProb = 0;
      var probPowerFactor = -1; //bad value to fail if not set
      for (var j = 0 ; j < probTable[amountFloor].length ; j++) {
        cumulativeProb += probTable[amountFloor][j];
        if (rnd < cumulativeProb) {
          console.log(" - - - hit table at position "+j);
          // MATCH
          probPowerFactor = j;
          break;
        }
      }
      // TODO : factor adjustments on power could be done here
      var votePower = probPowerFactor;
      console.log(" - - - vote power = "+votePower+" pc");
      // now adjust to Steem scaling
      votePower *= VOTE_POWER_1_PC;
      // do vote (note that this does not need to be wrapped)
      // TODO : allow this voting
      /*
      var upvoteResult = wait.for(steem.broadcast.vote,
        process.env.POSTING_KEY_PRV,
        process.env.STEEM_USER,
        transfer.author,
        transfer.permlink,
        votePower);
        */
    }
    callback(null);
  });
}

/*
 getSteemPowerFromVest(vest):
 * converts vesting steem (from get user query) to Steem Power (as on Steemit.com website)
 */
function getSteemPowerFromVest(steemGlobalProperties, vest) {
  try {
    return steem.formatter.vestToSteem(
      vest,
      parseFloat(steemGlobalProperties.total_vesting_shares),
      parseFloat(steemGlobalProperties.total_vesting_fund_steem)
    );
  } catch(err) {
    return 0;
  }
}

function steem_getSteemGlobaleProperties_wrapper(callback) {
  steem.api.getDynamicGlobalProperties(function(err, properties) {
    callback(err, properties);
  });
}

function steem_getAccounts_wrapper(callback) {
  steem.api.getAccounts([process.env.STEEM_USER], function(err, result) {
    callback(err, result);
  });
}

function steem_getAccountHistory_wrapper(start, limit, callback) {
  steem.api.getAccountHistory(process.env.STEEM_USER, start, limit, function (err, result) {
    callback(err, result);
  });
}

function steem_getContent_wrapper(author, permlink, callback) {
  steem.api.getContent(author, permlink, function (err, result) {
    callback(err, result);
  });
}

function readTransfers(lastTransactionTimeAsEpoch,
                          lastTransactionNumber,
                          callback) {
  wait.launchFiber(function() {
    var transfers = [];
    var keepProcessing = true;
    var idx = 0;
    var transactionCounter = 0;
    while(keepProcessing) {
      var result = wait.for(steem_getAccountHistory_wrapper,
        idx + RECORDS_FETCH_LIMIT, RECORDS_FETCH_LIMIT);
      if (result === undefined || result === null
          || result.length < 1) {
        console.log("fatal error, cannot get account history" +
          " (transfers), may be finished normally, run out of data");
        callback(transfers);
        keepProcessing = false;
        break;
      } else {
        //console.log(JSON.stringify(result));
        for (var j = 0 ; j < result.length ; j++) {
          var r = result[j];
          if (r[0] < transactionCounter) {
            // this means the API returned older results than we asked
            // for, meaning there are no more recent transactions to get
            console.log("API has no more results, ending fetch");
            callback(transfers);
            keepProcessing = false;
            break;
          }
          transactionCounter = r[0];
          if (r !== undefined && r !== null && r.length > 1) {
            var transaction = r[1];
            var ops = transaction.op;
            if (ops === undefined || ops === null || ops.length < 2) {
              console.log("processTransactionOp_recursive failed, back ops: "+JSON.stringify(ops));
            } else {
              for (var i = 0 ; i < ops.length ; i += 2) {
                var opName = ops[i];
                //console.log(" - op: "+opName);
                if (opName.localeCompare("transfer") == 0) {
                  var opDetail = ops[i+1];
                  // verifyTransferIsValid
                  console.log(" - - - - detail: "+JSON.stringify(opDetail));
                  var amountParts = opDetail.amount.split(" ");
                  if (amountParts.length === 2) {
                    var amount = Number(amountParts[0]);
                    var asset = amountParts[1];
                    if (asset.localeCompare("STEEM") == 0) {
                      console.log(" - - - - MATCH, is for STEEM");
                      if (amount >= 1.0) {
                        console.log(" - - - - MATCH, amount >= 1.0");
                        var parts = opDetail.memo.split("/");
                        if (parts.length > 0) {
                          var permlink = parts[parts.length - 1];
                          var author = null;
                          for (var i = 0; i < parts.length; i++) {
                            if (S(parts[i]).startsWith("@")) {
                              author = parts[i].substr(1, parts[i].length);
                            }
                          }
                          if (author !== null) {
                            // check exists by fetching from Steem API
                            var content = wait.for(steem_getContent_wrapper, author, permlink);
                            if (content == undefined || content === null) {
                              console.log("Transfer memo does not" +
                                " contain valid post URL" +
                                " (failed at fetch author/permlink content from API): "
                                + opDetail.memo);
                            } else {
                              //console.log("DEBUG get post content: " +
                              // JSON.stringify(content));
                              var match = false;
                              try {
                                for (var k = 0 ; k < content.active_votes.length ; k++) {
                                  if (content.active_votes[k].voter.localeCompare(process.env.STEEM_USER) == 0) {
                                    match = true;
                                    break;
                                  }
                                }
                              } catch(err) {
                                console.log("Error analysing memo linked" +
                                  " post for votes");
                              }
                              if (match) {
                                console.log("Already voted on this post," +
                                  " skipping");
                              } else {
                                // check time since posted is < (7 days
                                // - 12 hrs)
                                var cashoutTime = moment(content.cashout_time);
                                cashoutTime.subtract(7, 'hours');
                                var nowTime = moment(new Date());
                                if (nowTime.isBefore(cashoutTime)) {
                                  // PASSES ALL TESTS
                                  // add author and permlink to detail,
                                  //    and number amount
                                  opDetail.author = author;
                                  opDetail.permlink = permlink;
                                  opDetail.number_amount = amount;
                                  // add to list
                                  transfers.push(opDetail);
                                  console.log("MEMO LINKED POST PASSES" +
                                    " TESTS, will vote on");
                                } else {
                                  console.log("Memo linked post is too" +
                                    " old to vote on, skipping");
                                }
                              }
                            }
                          } else {
                            console.log("Transfer memo does not contain valid post URL (failed" +
                              " to find user name at @ symbol): " + opDetail.memo);
                          }
                        } else {
                          console.log("Transfer memo does not contain valid post URL (failed" +
                            " at URL split by /): " + opDetail.memo);
                        }
                      } else {
                        console.log("Transfer amount < 1.0 STEEM");
                      }
                    } else {
                      console.log("Transfer is not for STEEM");
                    }
                  } else {
                    console.log("Transfer amount field is invalid");
                  }
                }
              }
            }
            idx += RECORDS_FETCH_LIMIT;
          } else {
            console.log("fatal error, cannot get account history" +
              " (transfers), may be finished normally, run out of data");
            callback(transfers);
            keepProcessing = false;
            break;
          }
        }
      }
    }
  });
}

function getLastInfos(callback) {
  db.collection(DB_RECORDS).find({}).toArray(function(err, data) {
    if (err) {
      console.log(err);
      console.log("Error, exiting");
      callback(0, 0);
      return;
    }
    var lastTransactionNumber = -1;
    var lastTransactionTimeAsEpoch = 0;
    if (process.env.START_TIME_AS_EPOCH !== undefined
      && process.env.START_TIME_AS_EPOCH !== null) {
      try {
        lastTransactionTimeAsEpoch = Number(process.env.START_TIME_AS_EPOCH);
      } catch(err) {
        console.log("Error converting env var START_TIME_AS_EPOCH to" +
          " number");
        lastTransactionTimeAsEpoch = 0;
      }
    }
    if (data === undefined || data === null) {
      console.log("Db data does not exist, consider this a first time run");
      try {
        if (lastTransactionTimeAsEpoch < data[0].timeAsEpoch) {
          lastTransactionTimeAsEpoch = data[0].timeAsEpoch;
        }
        lastTransactionNumber = data[0].trxNumber;
      } catch(err) {
        console.log(err);
        console.log("not fatal, continuing");
      }
    }
    callback(lastTransactionTimeAsEpoch, lastTransactionNumber);
  });
}


// NOTE, these tables are the transpose of the originals

const
  votePowerProb_lv3 = [
    // each item in array is 1% more power, starting at 1%
    [0.5, .25, .125, .0625, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01], // 1 STEEM
    [0.01, 0.5, .25, .125, .0625, 0.01, 0.01, 0.01, 0.01, 0.01], // 2 STEEM
    [0.01, 0.01, 0.5, .25, .125, .0625, 0.01, 0.01, 0.01, 0.01], // 3 STEEM
    [0.01, 0.01, 0.01, 0.5, .25, .125, .0625, 0.01, 0.01, 0.01], // 4 STEEM
    [0.01, 0.01, 0.01, 0.01, 0.5, .25, .125, .0625, 0.01, 0.01], // 5 STEEM
    [0.01, 0.01, 0.01, 0.01, 0.01, 0.5, .25, .125, .0625, 0.01], // 6 STEEM
    [0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.5, .25, .125, .0625], // 7 STEEM
    [0.01, 0.01, 0.01, 0.01, 0.01, 0.01, .0625, 0.5, .25, .125], // 8 STEEM
    [0.01, 0.01, 0.01, 0.01, 0.01, 0.01, .0625, .125, 0.5, .25], // 9 STEEM
    [0.01, 0.01, 0.01, 0.01, 0.01, 0.01, .0625, .125, .25, 0.5]  // 10 STEEM
    // >10 STEEM use 10 STEEM values
  ];

const
  votePowerProb_lv2 = [
    // each item in array is 1% more power, starting at 1%
    [.5, .25, .125, .0625, .0625], // 1 STEEM
    [.0625, .5, .25, .125, .0625], // 2 STEEM
    [.0625, .0625, .5, .25, .125], // 3 STEEM
    [.0625, .0625, .125, .5, .25], // 4 STEEM
    [.0625, .0625, .125, .25, .5]  // 5 STEEM
  ];

const
  votePowerProb_lv1 = [
    // each item in array is 1% more power, starting at 1%
    [.75, .25], // 1 STEEM
    [.25, .75]  // 2 STEEM
  ];

const
  votePowerProb_levelSp = [
    60000, 150000, 300000
  ];

const
  votePowerProb_levelTables = [
    votePowerProb_lv1,
    votePowerProb_lv2,
    votePowerProb_lv3
  ];