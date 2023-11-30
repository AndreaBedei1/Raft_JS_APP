import { createServer, Server as HTTPServer } from "http";
import { Server } from "socket.io";
import { Socket as SocketCl, io } from "socket.io-client"
import { RPCType } from "../enums/RPCType.js";
import { AppendEntriesParameters, RequestVoteParameters, SnapshotParameters } from "./RPCParameters.js";
import { State } from "../enums/State.js";
import { RPCManager } from "./RPCManager.js";
import { LogRecord, AuctionCreateData, AuctionCloseData, UserCreateData, BidCreateData } from "./Log.js";
import { error } from "console";
import { DBManager } from "./DBManager.js";
import { CommandType } from "../enums/CommandType.js";
import { WebServerManager } from "./WebServerManager.js";

// const MAX_ENTRIES_IN_REQUEST = 10;  // Max number of request that can be put together in a single request.

export class RaftNode {
    /**
     * Creates a new node for the Raft consensus protocol cluster.
     * @param {String} id Id of this node.
     * @param {Number} portNodeProt Port of the protocol Node.
     * @param {Number} portWebServer Port of the web Server.
     * @param {Number} minLeaderTimeout Minimum time in ms to wait before launching a new election after a leader timeout.
     * @param {Number} maxLeaderTimeout Maximum time in ms to wait before launching a new election after a leader timeout.
     * @param {Number} minElectionTimeout Minimum time in ms to wait before launching a new election after a failed one.
     * @param {Number} maxElectionTimeout Maximum time in ms to wait before launching a new election after a failed one.
     * @param {Number} minElectionDelay Minimum time in ms before a new election can be started. Elections started before this amount of time are ignored.
     * @param {Number} heartbeatTimeout Time in ms before sending a new heartbeat.
     * @param {String} hostForDB Hostname or IP address for the database connection.
     * @param {String} userForDB Database user.
     * @param {String} passwordForDB Database password.
     * @param {String} databaseName Name of the database.
     * @param {Map<String, String>} otherNodes Pairs IPAddress-IdNode for the other nodes in the cluster.
     * @param {boolean} [debug=false] Flag indicating whether debugging is enabled.
     */

    constructor(id, portNodeProt, portWebServer, minLeaderTimeout, maxLeaderTimeout, minElectionTimeout, maxElectionTimeout, minElectionDelay, heartbeatTimeout, hostForDB, userForDB, passwordForDB, databaseName, otherNodes, debug = false, disabledDB = false) {
        /** @type {String} */
        this.id = id;
        /** @type {Number} */
        this.portNodeProt = portNodeProt;
        /** @type {Boolean} */
        this.started = false;
        /** @type {String} */
        this.state = State.FOLLOWER;
        /** @type {Number} */
        this.currentTerm = 0;
        /** @type {String} */
        this.votedFor = null;
        /** @type {Number} */
        this.votesGathered = 0;
        /** @type {LogRecord[]} */
        this.log = [];
        /** @type {Number} */
        this.commitIndex = -1;
        /** @type {Number} */
        this.lastApplied = -1;
        /** @type {Number} */
        this.minLeaderTimeout = minLeaderTimeout;
        /** @type {Number} */
        this.maxLeaderTimeout = maxLeaderTimeout;
        /** @type {Number} */
        this.minElectionTimeout = minElectionTimeout;
        /** @type {Number} */
        this.maxElectionTimeout = maxElectionTimeout;
        /** @type {Number} */
        this.minElectionDelay = minElectionDelay;
        /** @type {Number} */
        this.heartbeatTimeout = heartbeatTimeout

        if (!disabledDB) {
            /** @type {DBManager} */
            this.dbManager = new DBManager(hostForDB, userForDB, passwordForDB, databaseName);
        }

        /** @type {WebServerManager} */
        this.webServerManager = new WebServerManager(this, portWebServer);

        /**
         * Leader-only.
         * 
         * Index of the next log entry to send to each follower node, initialized after every election to the index of the last record in the leader's log +1.
         * @type {Map<String, Number>}
         */
        this.nextIndex = new Map();
        /**
         * Leader-only.
         * 
         * Index of highest log entry known to be replicated on each follower node. Reinitialized after every election. 
         * @type {Map<String, Number>}
         */
        this.matchIndex = new Map();
        /** @type {Map<String, String>} */
        this.otherNodes = otherNodes;

        /** @type {Number} */
        this.clusterSize = otherNodes.size + 1;

        /** @type {String | null} */
        this.currentLeaderId = null;

        /** @type {Map<String, Number | null>} */
        this.heartbeatTimeouts = new Map();

        /** @type {HTTPServer | null} */
        this.protocolHttpServer = null;
        /** @type {Server | null} */
        this.protocolServer = null;

        /** 
         * Maps the socket id to the corresponding node id. 
         * @type {Map<String, String>} 
        */
        this.socketToNodeId = new Map();

        /**
         * Maps the node id to the corresponding socket.
         *  @type {Map<String, SocketCl>} 
        */
        this.sockets = new Map();

        /** @type {Number} */
        this.leaderTimeout = null;

        /** @type {Number} */
        this.electionTimeout = null;

        /** @type {RPCManager} */
        this.rpcManager = new RPCManager(this.sockets, this.id);

        /** @type {Boolean} */
        this.debug = debug;

        /** @type {Boolean} */
        this.disabledDB = disabledDB;
    }

    // FIXME: client disconnects after receiving appendentries. Maybe server closes connection?

    /**
     * Starts the node.
     */
    start() {
        if (this.started) {
            throw new Error("Node is already active.");
        }

        this.debugLog("Starting node...");

        if (!this.disabledDB) {
            // Connect the node to the database through its DBmanager.
            this.dbManager.connect();
        }

        //FIXME: delete protocolHTTPServer

        this.protocolServer = new Server();

        let serverNode = this;

        this.protocolServer.on("connection", socket => {    // Handle connections to this node.
            socket.emit("accept");

            // TODO: accept only qualified connections??

            // if (serverNode.otherNodes.get(socket.handshake.address) != undefined) {
            // } else {
            //     socket.disconnect(true);    // Connections from addresses not in the configuration are closed immediately.
            //     return;
            // }

            socket.on(RPCType.APPENDENTRIES, args => this.onAppendEntriesMessage(socket, args));
            socket.on(RPCType.REQUESTVOTE, args => this.onRequestVoteMessage(socket, args));
            // socket.on(RPCType.SNAPSHOT, args => this.onSnapshotMessage(socket, args));

            serverNode.heartbeatTimeouts.set(serverNode.socketToNodeId.get(socket.id), null);
        });

        this.protocolServer.listen(this.portNodeProt);
        this.debugLog("Protocol server listening on port " + this.portNodeProt);

        this.webServerManager.start();
        this.debugLog("Web server listening on port " + this.webServerManager.webServerPort);

        // Connect to other nodes.
        this.otherNodes.forEach((id, host) => {
            this.debugLog("Connecting to " + host);

            let sock = io("ws://" + host, {
                autoConnect: false,
                reconnection: true,
                reconnectionAttempts: 5,
                reconnectionDelay: 10000,
            });

            sock.connect();

            let accepted = false;
            // let shutdown = false;

            sock.on("connect", () => {
                this.debugLog("Connection established with %s.", id);
            });

            sock.on("accept", () => {
                accepted = true;
                this.debugLog("Connection accepted.");
            });
            
            sock.on("connect_error", (err) => {
                this.debugLog("Failed to connect: " + err.message);
            });

            // sock.on("shutdown", () => {
            //     shutdown = true;
            // });

            sock.on("disconnect", (reason) => {
                if (reason === "server namespace disconnect") {         // Disconnected because not in configuration.
                    if (accepted) {
                        this.debugLog("Server shutdown");
                    } else {
                        this.debugLog("Connection refused by server.");
                    }
                } else {
                    this.debugLog("Disconnected from %s, reason: '%s', attempting reconnection...", id, reason);
                }
            });

            this.sockets.set(id, sock);
            this.socketToNodeId.set(sock.id, id);
        });

        this.debugLog("Node started.");

        this.waitForLeaderTimeout();    // Waits before attempting to start the first ever election.
    }

    /**
     * Stops the node gracefully by closing all connections.
     */
    stop() {
        if (!this.started) {
            throw new Error("Node is not active.");
        }

        this.debugLog("Stopping node...");

        if (!this.disabledDB) {
            // Disconnect the node to the database through its DBmanager.
            this.dbManager.disconnect();
        }

        // this.protocolHttpServer.close();
        this.protocolServer.close();
        this.protocolServer.disconnectSockets(true);

        this.webServerManager.stop();

        this.sockets.clear();
        this.socketToNodeId.clear();

        this.debugLog("Node stopped");
    }

    applyLogEntry(index) {
        let logEntry = this.log.at(index);

        if (logEntry) {
            let res = null;
            switch (logEntry.commandType) {
                case CommandType.NEW_USER: {
                    /** @type {UserCreateData} */
                    let data = logEntry.logData;

                    if (!this.disabledDB) {
                        res = this.dbManager.queryAddNewUser(data.username, data.password);
                    }
                    this.debugLog("Added new user to database.");
                    break;
                }
                case CommandType.NEW_AUCTION: {
                    /** @type {AuctionCreateData} */
                    let data = logEntry.logData;

                    if (!this.disabledDB) {
                        res = this.dbManager.queryAddNewAuction(data.user, data.startDate, data.objName, data.objDesc, data.startPrice);
                    }
                    this.debugLog("Added new auction to database.");
                    break;
                }
                case CommandType.CLOSE_AUCTION: {
                    /** @type {AuctionCloseData} */
                    let data = logEntry.logData;

                    if (!this.disabledDB) {
                        res = this.dbManager.queryCloseAuction(data.auctionId, data.closingDate);
                    }
                    this.debugLog("Closed auction in database.");
                    break;
                }
                case CommandType.NEW_BID: {
                    /** @type {BidCreateData} */
                    let data = logEntry.logData;

                    if (!this.dbManager) {
                        res = this.dbManager.queryAddNewBid(data.user, data.auctionId, data.value);
                    }
                    this.debugLog("Added new bid to database.");
                    break;
                }
                default: {
                    throw new Error("Unknown command type '" + logEntry.commandType + "'");
                }
            }

            logEntry.callback(res); // Fulfill promise to web server by sending another promise.
        } else {
            throw new Error("Log entry at index " + index + "is undefined.");
        }
    }

    // FIXME: remove sender parameter from onAppendEntriesMessage and the other. maybe put 'this.sockets.get(args.senderId)' in a variable

    /**
     * Handles incoming AppendEntries RPC messages.
     * @param {SocketCl} sender The socket representing the sender node.
     * @param {AppendEntriesParameters} args The parameters of the AppendEntries RPC.
     */
    onAppendEntriesMessage(sender, args) {
        if (args.term > this.currentTerm) {     // Contact from a more recent leader.
            switch (this.state) {
                case State.LEADER: {        // Stops waiting for heartbeat timeout because it's no longer the leader.
                    this.stopHeartbeatTimeout();
                    break;
                }
                case State.CANDIDATE: {     // Stops waiting for heartbeat and election timeout because it's no longer a candidate.
                    this.stopHeartbeatTimeout();
                    this.stopElectionTimeout();
                    break;
                }
                default:
                    break;
            }
            this.state = State.FOLLOWER;
            this.currentLeaderId = args.isResponse ? null : args.senderId;
            this.currentTerm = args.term;
            this.resetLeaderTimeout();

            this.debugLog("New leader detected. Changing to %s state...", State.FOLLOWER);
        }

        switch (this.state) {
            case State.FOLLOWER: {
                if (args.isResponse) {
                    this.rpcManager.sendReplicationResponse(this.sockets.get(args.senderId), this.currentTerm, false, this.commitIndex);
                    this.debugLog("Received \"%s\" response from %s -> refused.", RPCType.APPENDENTRIES, args.senderId);
                    break;
                }

                if (args.term < this.currentTerm ||
                    (this.log[args.prevLogIndex] && this.log[args.prevLogIndex].term !== args.prevLogTerm)) {   // FIXME: unsure
                    this.rpcManager.sendReplicationResponse(this.sockets.get(args.senderId), this.currentTerm, false, this.commitIndex);
                    this.debugLog("Received %s message from %s with previous term %d -> refused.", RPCType.APPENDENTRIES, args.senderId, args.term);
                    break;
                }

                if (this.currentLeaderId == null) {            // Leader may not be known (see in case State.LEADER)
                    this.currentLeaderId = args.senderId;
                }

                if (args.entries.length > 0) {
                    args.entries.forEach((e, i) => {
                        if (this.log[args.prevLogIndex + i + 1].term !== e.term) {
                            this.log.length = args.prevLogIndex + i + 1;    // Delete all records starting from the conflicting one.
                            this.debugLog("Conflicting entry/ies found and removed from log.");
                        }
                        this.log.push(e);
                    });
                    this.debugLog("Added %d entries to log", args.entries.length);
                }

                if (args.entries.length > 0 && args.leaderCommit > this.commitIndex) {
                    let lastIndex = args.prevLogIndex ?? -1 + args.entries.length;
                    for (let i = this.commitIndex + 1; i <= lastIndex; i++) {   // Applies log entries to the database.
                        this.applyLogEntry(i);
                    }

                    this.debugLog("Committed %d log entries to database.", args.leaderCommit - this.commitIndex);
                    this.commitIndex = lastIndex < args.leaderCommit ? lastIndex : args.leaderCommit;
                }

                this.rpcManager.sendReplicationResponse(this.sockets.get(args.senderId), this.currentTerm, true, this.commitIndex);
                this.debugLog("Received \"%s\" request from %s with term %d -> responded.", RPCType.APPENDENTRIES, args.senderId, args.term);
                this.resetLeaderTimeout();
                break;
            }
            case State.LEADER: {
                // This message is sent by an older leader and is no longer relevant.
                if (!args.isResponse) {
                    this.rpcManager.sendReplicationResponse(this.sockets.get(args.senderId), this.currentTerm, false, this.commitIndex);
                    this.debugLog("Received \"%s\" request from %s with previous term %d -> refused.", RPCType.APPENDENTRIES, args.senderId, args.term);
                }

                if (args.success) { // Leader was not rejected.
                    this.matchIndex.set(args.senderId, args.matchIndex);
                    this.nextIndex.set(args.senderId, args.matchIndex + 1);

                    let prevLogIndex = this.nextIndex[args.senderId] - 1;
                    let prevLogTerm = this.log[prevLogIndex];

                    // Sends missing entries to the node.
                    let missingEntries = this.log.slice(args.matchIndex + 1);
                    if (missingEntries.length > 0) {
                        this.rpcManager.sendReplicationTo(this.sockets.get(args.senderId), this.currentTerm, prevLogIndex, prevLogTerm, missingEntries, this.commitIndex);
                        this.debugLog("Received successful \"%s\" response from %s requesting missing entries -> responded.", RPCType.APPENDENTRIES, args.senderId);
                        this.resetHeartbeatTimeout(args.senderId);
                    } else {
                        this.debugLog("Received successful \"%s\" response from %s -> ignored (ok).", RPCType.APPENDENTRIES, args.senderId);
                    }

                    // Server applies to the database the newly committed entries.
                    let sortedIndexes = [...this.matchIndex.values()].sort();
                    let oldCommitIndex = this.commitIndex;

                    for (let i = sortedIndexes.length - 1; i >= 0; i--) {
                        if (sortedIndexes.filter(index => index >= i).length > Math.floor(this.clusterSize / 2)) {
                            this.commitIndex = sortedIndexes[i];
                            break;
                        }
                    }

                    for (let i = oldCommitIndex + 1; i <= this.commitIndex; i++) {
                        this.applyLogEntry(i);
                    }
                } else {
                    this.debugLog("Received unsuccessful \"%s\" response from %s -> ignored.", RPCType.APPENDENTRIES, args.senderId);
                }
                break; // Nothing is done if it's a log conflict, eventually a new election will start and the new leader fix things.
            }
            case State.CANDIDATE: {
                this.rpcManager.sendReplicationResponse(this.sockets.get(args.senderId), this.currentTerm, false, this.commitIndex); // The message is for a previous term and it is rejected.
                this.debugLog("Received \"%s\" message from %s with outdated term %d -> refused.", RPCType.APPENDENTRIES, args.senderId, args.term);
                break;
            }
            default: {
                break;
            }
        }
    }

    /**
     * Handles incoming RequestVote RPC messages.
     * @param {SocketCl} sender The socket representing the sender node.
     * @param {RequestVoteParameters} args The parameters of the RequestVote RPC.
     */
    onRequestVoteMessage(sender, args) {
        if (args.term > this.currentTerm) {     // Contact from a more recent candidate.
            switch (this.state) {
                case State.LEADER: {            // Stops waiting for heartbeat timeout because it's no longer the leader.
                    this.stopHeartbeatTimeout();
                    break;
                }
                case State.CANDIDATE: {         // Stops waiting for heartbeat and election timeout because it's no longer a candidate.
                    this.stopHeartbeatTimeout();
                    this.stopElectionTimeout();
                    break;
                }
                default:
                    break;
            }
            this.state = State.FOLLOWER;
            this.votedFor = null;
            this.currentLeaderId = null;
            this.currentTerm = args.term;
            this.resetLeaderTimeout();

            this.debugLog("New election detected. Changing to %s state...", State.FOLLOWER);
        }

        switch (this.state) {
            case State.FOLLOWER: {
                if (this.votedFor == null) {
                    this.votedFor = args.senderId;
                    this.rpcManager.sendVote(this.sockets.get(args.senderId), this.currentTerm, true);
                    this.debugLog("Received \"%s\" request from %s -> cast vote.", RPCType.REQUESTVOTE, args.senderId);
                    this.resetLeaderTimeout();
                } else {
                    this.rpcManager.sendVote(this.sockets.get(args.senderId), this.currentTerm, false);
                    this.debugLog("Received \"%s\" request from %s -> refuse vote.", RPCType.REQUESTVOTE, args.senderId);
                }
                break;
            }
            case State.LEADER: {
                if (!args.isResponse) {
                    this.rpcManager.sendVote(this.sockets.get(args.senderId), this.currentTerm, false);
                    this.debugLog("Received \"%s\" request from loser candidate %s -> refuse vote.", RPCType.REQUESTVOTE, args.senderId);
                } else {
                    this.debugLog("Received \"%s\" request from loser candidate %s -> ignore.", RPCType.REQUESTVOTE, args.senderId)
                }
                break;
            }
            case State.CANDIDATE: {
                if (args.isResponse) {
                    this.stopHeartbeatTimeout(args.senderId);
                    if (args.voteGranted) {
                        this.debugLog("Received vote confirmation from %s. Votes obtained so far: %d.", args.senderId, this.votesGathered + 1);
                        if (++this.votesGathered > Math.floor(this.clusterSize / 2)) {
                            this.debugLog("Majority obtained -> changing state to leader and notifying other nodes.");
                            this.state = State.LEADER;
                            this.rpcManager.sendReplication(this.currentTerm, this.log.length - 1, (this.log[-1] != null ? this.log[-1].term : null), [], this.commitIndex);
                            this.resetHeartbeatTimeout();
                            this.stopElectionTimeout();
                        }
                    } else {
                        this.debugLog("Received vote refusal from %s.", args.senderId);
                    }
                } else {
                    this.rpcManager.sendVote(this.sockets.get(args.senderId), this.currentTerm, false);
                    this.debugLog("Received \"%s\" request from other candidate %s -> refuse vote.", RPCType.REQUESTVOTE, args.senderId);
                }
                break;
            }
            default:
                break;
        }
    }

    /**
     * Handles incoming Snapshot RPC messages.
     * @param {SocketCl} sender The socket representing the sender node.
     * @param {SnapshotParameters} args The parameters of the Snapshot RPC.
     */
    onSnapshotMessage(payload) {
        return; // Not implemented.
    }

    startNewElection() {
        this.leaderTimeout = null; // Timeout has expired.

        this.state = State.CANDIDATE;
        this.currentTerm++;
        this.currentLeaderId = null;
        this.votesGathered = 1;
        this.rpcManager.sendElectionNotice(this.currentTerm, this.id, this.log.length - 1, this.log[-1] != null ? this.log[-1].term : null);
        this.stopLeaderTimeout();       // Disables leader timeout.
        this.resetElectionTimeout();    // Set a timeout in case the election doesn't end.
        this.resetHeartbeatTimeout();   // Set a timeout in case other nodes do not respond.
    }
    /**
     * Set a timeout for communications from the leader.
     * 
     * In case the timeout expires, starts a new election as a candidate.
     */
    waitForLeaderTimeout() {
        let extractedInterval = this.minLeaderTimeout + Math.random() * (this.maxLeaderTimeout - this.minLeaderTimeout);
        let node = this;
        this.leaderTimeout = setTimeout(() => {
            node.debugLog("Leader timeout expired! Starting new election...");
            node.startNewElection();
        }, extractedInterval);
    }

    /**
     * Set a timeout for the current election.
     * 
     * In case the timeout expires, starts a new election as a candidate.
     */
    waitForElectionTimeout() {
        let extractedInterval = this.minElectionTimeout + Math.random() * (this.maxElectionTimeout - this.minElectionTimeout);
        let node = this;
        this.electionTimeout = setTimeout(() => {
            node.debugLog("Election timeout expired! Starting new election...");
            node.startNewElection();
        }, extractedInterval)
    }

    /**
     * Set a timeout to wait for any heartbeat.
     * 
     * In case the timeout expires, sends another heartbeat of type depending on the current state.
     * @param {Number} matchIndex Index of highest log entry known to be replicated on each follower node.
     * @param {String | null} nodeId The node to which we must send the heartbeat when the timeout expires. If null, the heartbeat is sent to all other nodes.
     */
    waitForHeartbeatTimeout(nodeId = null) {
        let thisNode = this;
        let sendHeartbeat = null;

        if (thisNode.state === State.CANDIDATE) {  // The message sent is a vote request.
            sendHeartbeat = (nodeId) => {
                thisNode.rpcManager.sendElectionNoticeTo(thisNode.sockets.get(nodeId), thisNode.currentTerm, thisNode.id, thisNode.log.length - 1, thisNode.log[-1] != null ? thisNode.log[-1].term : null);
                thisNode.debugLog("Sending new election heartbeat to node %s", nodeId);
                thisNode.resetHeartbeatTimeout(nodeId);
            };
        } else if (thisNode.state === State.LEADER) {    // The message sent is a replication request.
            sendHeartbeat = (nodeId) => {
                let missingEntries = thisNode.log.slice(thisNode.matchIndex.get(nodeId) + 1);
                let prevLogIndex = thisNode.nextIndex[nodeId] - 1;
                let prevLogTerm = thisNode.log[prevLogIndex];
                thisNode.rpcManager.sendReplicationTo(thisNode.sockets.get(nodeId), thisNode.currentTerm, prevLogIndex, prevLogTerm, missingEntries, thisNode.commitIndex);
                thisNode.debugLog("Sending new heartbeat with %d entries to node %s", missingEntries.length, nodeId);
                thisNode.resetHeartbeatTimeout(nodeId);
            };
        } else { // Illegal state.
            throw new Error("Cannot send heartbeat when in state " + Object.entries(State).find(e => e[1] === thisNode.state).at(0));
        }

        if (nodeId != null) { // Sends an heartbeat to a specified node.
            thisNode.heartbeatTimeouts.set(nodeId, setTimeout(() => sendHeartbeat(nodeId), thisNode.heartbeatTimeout));
        } else { // Sends an heartbeat to all other nodes.
            thisNode.otherNodes.forEach((nodeId, _) => {
                thisNode.heartbeatTimeouts.set(nodeId, setTimeout(() => sendHeartbeat(nodeId), thisNode.heartbeatTimeout));
            });
        }
    }

    /**
    * Resets the leader timeout by stopping the current timeout and initiating a new one.
    */
    resetLeaderTimeout() {
        this.stopLeaderTimeout();
        this.waitForLeaderTimeout();
    }

    /**
     * Resets the election timeout by stopping the current timeout and initiating a new one.
     */
    resetElectionTimeout() {
        this.stopElectionTimeout();
        this.waitForElectionTimeout();
    }

    /**
     * Resets the heartbeat timeout for a specific node or all nodes.
     * @param {String | null} nodeId - The ID of the node for which to reset the heartbeat timeout.
     */
    resetHeartbeatTimeout(nodeId = null) {
        this.stopHeartbeatTimeout(nodeId);
        this.waitForHeartbeatTimeout(nodeId);
    }

    /**
     * Stops the leader timeout, preventing a new election from starting.
     */
    stopLeaderTimeout() {
        clearTimeout(this.leaderTimeout);
        this.leaderTimeout = null;
    }

    /**
     * Stops the election timeout, preventing a new election from starting.
    */
    stopElectionTimeout() {
        clearTimeout(this.electionTimeout);
        this.electionTimeout = null;
    }

    /**
     * Stops the heartbeat timeout for a specific node or all nodes.
     * @param {String | null} nodeId - The ID of the node for which to stop the heartbeat timeout. If null, stops all timeouts.
    */
    stopHeartbeatTimeout(nodeId = null) {
        if (nodeId != null) {
            clearTimeout(this.heartbeatTimeouts.get(nodeId));
            this.heartbeatTimeouts.delete(nodeId);
        } else {
            this.sockets.forEach((_, id) => {
                clearInterval(this.heartbeatTimeouts.get(id));
            });
            this.heartbeatTimeouts.clear();
        }
    }

    debugLog(message, ...optionalParams) {
        if (this.debug) {
            console.log("[" + this.id + " (" + this.state + ")]: " + message, ...optionalParams);
        }
    }
}