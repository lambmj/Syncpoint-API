// these are some helper function that have been useful across the listner modules
// this set should grow and become more structured as we add auth plugins, etc

var coux = require('coux').coux,
  e = require('errLog').e,
  control_ddoc = require('./design/control'),
  userChannelControl = require('./userChannelControl');

exports.configDDoc = function(config) {
  var ddoc = require('./design/console');
  if (ddoc.sp_config) {
    ['admin_db', 'users_db', 'users_db', 'admin_db'].forEach(function(key) {
      ddoc.sp_config[key] = config[key];
    })
  }
  return ddoc;
};

function fieldToProvision(pairingDoc) {
  if (pairingDoc.pairing_mode == "single-channel") {
    return "channel_database";
  } else {
    return "control_database";
  }
}

function setupControlDatabase(pairingDoc, userDoc, config, callback) {
  var provisionFieldName = fieldToProvision(pairingDoc);

  function setControlDatabaseName(userDoc) {
      if (!userDoc[provisionFieldName]) {
          coux([config.host, "_uuids"], e(function(err, data) {
            var dbPrefix;
            if (provisionFieldName == "control_database") {
              dbPrefix = "control-";
            } else {
              dbPrefix = "single-";
            }
              userDoc[provisionFieldName] = dbPrefix+data.uuids[0];
              ensureControlDatabaseExists(userDoc, true)
          }))
      } else {
          ensureControlDatabaseExists(userDoc)
      }
  }
  function ensureControlDatabaseExists(userDoc, isNew) {
      // find or create a control database
      coux([config.host, userDoc[provisionFieldName]], function(err, ok) {
          if (err) {
              console.log("create control", userDoc[provisionFieldName]);
              coux.put([config.host, userDoc[provisionFieldName]], 
                  e(secureControlDb, [userDoc, isNew]));
          } else {
              secureControlDb(userDoc, isNew);
          }
      })
  }
  function secureControlDb(userDoc, isNew) {
      // once a database has a member, it is not public
      exports.addMemberToDatabase(userDoc._id, 
          [config.host, userDoc[provisionFieldName]],
          e(addControlDesign,[userDoc, isNew]));
  }
  function addControlDesign(userDoc, isNew) {
    if (userDoc.control_database) {
      coux.put([config.host, userDoc[provisionFieldName], control_ddoc._id], 
        control_ddoc, function(err, ok) {
        if (err && err.error != "conflict") {
          console.trace(JSON.stringify(err))
        } else {
          callback(false, userDoc, isNew)
        }
      })
    } else {
      callback(false, userDoc, isNew)
    }
  }
  setControlDatabaseName(userDoc);
}

exports.activateWebUser = function(webUserDoc, config) {
  setupControlDatabase(webUserDoc, webUserDoc, config, e(function(err, userDoc, isNew) {
    userDoc.pairing_state = "paired";
    coux.put([config.host, config.users_db, userDoc._id], userDoc, e(function(err, ok) {
      if (isNew && userDoc.control_database) {
        userChannelControl.bindToControlDb(userDoc.control_database, userDoc.app_id, config);
        exports.replicateToGlobalControl(userDoc.control_database, config);
      }
    }));
  }));
};

// when an auth scheme +1s a new user pairing, they run this code to seal the deal.
exports.activatePairingUser = function(pairingUserDoc, userDoc, config) {
  var provisionFieldName = fieldToProvision(pairingUserDoc);

  function updateUserDocWithOauth(userDoc, isNew) {
      // update the user doc with the oauth credentials
      applyOauthCredsToUserDoc(userDoc, pairingUserDoc);
      coux.put([config.host, config.users_db, userDoc._id], 
          userDoc, e(pairPairingUserDoc,[userDoc, isNew]));
  }
  function pairPairingUserDoc(userDoc, isNew) {
    console.log("activate pairing for", userDoc._id, userDoc.full_name);
    // put the control database name and owner_id on the pairingUserDoc
    pairingUserDoc[provisionFieldName] = userDoc[provisionFieldName];
    pairingUserDoc.owner_id = userDoc._id;
    // update the pairing doc to be paired
    // when the mobile device see this, it will switch the session
    // to the user's control database
    pairingUserDoc.pairing_state = "paired";
    coux.put([config.host, config.users_db, pairingUserDoc._id],
      pairingUserDoc, e(function() {
        if (isNew && userDoc.control_database) {
          userChannelControl.bindToControlDb(userDoc.control_database, userDoc.app_id, config);
          exports.replicateToGlobalControl(userDoc.control_database, config);
        }
      }));
  }
  // kick off the chain:
  setupControlDatabase(pairingUserDoc, userDoc, config, e(function(err, userDoc, isNew) {
    updateUserDocWithOauth(userDoc, isNew)
  }))
}

exports.addMemberToDatabase = function(member, dbPath, cb) {
    dbPath = dbPath.concat("_security");
    coux(dbPath, e(function(err, secObj) {
        console.log("todo user ids in the security object", member);
        secObj.members = secObj.members || {};
            secObj.members.names = secObj.members.names || [];
        // TODO get the user ids in the security object right
        // and make the oauth connection stuff actually work
        cb(); // comment out this cb when todo is good :)
        
        // if (secObj.members.names.indexOf(member) == -1) {
        //     secObj.members.names.push(member);
        //     console.log("secObj update", secObj);
        //     coux.put(dbPath, secObj, cb);
        // } else {
        //     cb();
        // }
    }));
}


function applyOauthCredsToUserDoc(userDoc, credsDoc) {   
    var creds = credsDoc.sp_oauth, id = credsDoc._id;
    if (!userDoc.oauth) {
        userDoc.oauth = {
            consumer_keys : {},
            tokens : {}
        };        
    }
    if (!userDoc.oauth['devices']) {
        userDoc.oauth['devices'] =  {};
    }
    if (userDoc.oauth.consumer_keys[creds.consumer_key] || userDoc.oauth.tokens[creds.token]) {
        if (userDoc.oauth.consumer_keys[creds.consumer_key] == creds.consumer_secret &&
            userDoc.oauth.tokens[creds.token] == creds.token_secret &&
            userDoc.oauth.devices[id][0] == creds.consumer_key &&
            userDoc.oauth.devices[id][1] == creds.token) {
        // no op, no problem
        } else {
            return({error : "token_used", message : "device_id "+id});         
        }
    }
    userDoc.oauth.devices[id] = [creds.consumer_key, creds.token];
    userDoc.oauth.consumer_keys[creds.consumer_key] = creds.consumer_secret;
    userDoc.oauth.tokens[creds.token] = creds.token_secret;
}

// assuming we are still running on a version of couch that doesn't have 
// https://issues.apache.org/jira/browse/COUCHDB-1238 fixed
function setOAuthConfig(userDoc, id, creds, serverUrl, cb) {
    var rc = 0, ops = [
        ["oauth_consumer_secrets", creds.consumer_key, creds.consumer_secret],
        ["oauth_token_users", creds.token, userDoc.name],
        ["oauth_token_secrets", creds.token, creds.token_secret]
    ], oauthCB = function(err) {
        if (err) {
            cb(err)
        } else {
            rc += 1;
            if (rc == ops.length) {
                cb(false, userDoc)
            }
        }
    }
    for (var i=0; i < ops.length; i++) {
        var op = ops[i];
        coux.put([serverUrl, "_config", op[0], op[1]], op[2], oauthCB);
    }
}

exports.replicateToGlobalControl = function(db_name, config) {
  coux.put([config.host, '_replicator', 'global-'+db_name], {
    source : config.host + db_name,
    target : config.host + config.admin_db,
    continuous : true
  }, function(err, ok) {});
}
