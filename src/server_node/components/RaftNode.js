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

// const MAX_ENTRIES_IN_REQUEST = 10;  // Max number of request that can be put together in a single request.

export class RaftNode {
    /**
     * Creates a new node for the Raft consensus protocol cluster.
     * @param {String} id Id of this node.
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

    constructor(id, minLeaderTimeout, maxElectionTimeout, minElectionTimeout, minElectionDelay, heartbeatTimeout, hostForDB, userForDB, passwordForDB, databaseName, otherNodes, debug = false) {
        /** @type {String} */
        this.id = id;
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
        /** @type {DBManager} */
        this.dbManager = new DBManager(hostForDB, userForDB, passwordForDB, databaseName);
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
        this.clusterSize = otherNodes.length + 1;

        /** @type {String | null} */
        this.currentLeaderId = null;

        /** @type {Map<String, Number | null>} */
        this.heartbeatTimeouts = new Map();

        /** @type {HTTPServer | null} */
        this.protocolHttpServer = null;
        /** @type {Server | null} */
        this.protocolServer = null;

        /** @type {HTTPServer | null} */
        this.webHttpServer = null;

        /** @type {Server | null} */
        this.webServer = null;




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
        this.rpcManager = new RPCManager(Array.of(this.sockets.values()), this.id);

        /** @type {Boolean} */
        this.debug = debug;
    }

    /**
     * Starts the node.
     */
    start() {
        if (this.started) {
            throw new error("Node is already active.");
        }

        this.debugLog("Starting node...");

        // Connect the node to the database through its DBmanager.
        this.dbManager.connect();

        // Start node servers.
        this.protocolHttpServer = createServer();
        this.protocolServer = new Server(this.protocolHttpServer);
        this.webHttpServer = createServer();
        this.webServer = new Server(this.protocolHttpServer);




        let serverNode = this;
        this.protocolServer.on("connection", socket => {    // Handle connections to this node.
            if (otherNodes.get(socket.handshake.address) != undefined) {
                socket.emit("accept");
            } else {
                socket.disconnect(true);    // Connections from addresses not in the configuration are closed immediately.
                return;
            }

            socket.on(RPCType.APPENDENTRIES, args => this.onAppendEntriesMessage(socket, args));
            socket.on(RPCType.REQUESTVOTE, args => this.onRequestVoteMessage(socket, args));
            // socket.on(RPCType.SNAPSHOT, args => this.onSnapshotMessage(socket, args));

            serverNode.heartbeatTimeouts.set(id, null);
        });

        this.webServer.on("connection", socket => {    // Handle connections to this node.
            socket.on(CommandType.NEW_USER, (args, callback) => this.onRequest(CommandType.NEW_USER, args, callback));
            socket.on(CommandType.NEW_AUCTION, (args, callback) => this.onRequest(CommandType.NEW_AUCTION, args, callback));
            socket.on(CommandType.NEW_BID, (args, callback) => this.onRequest(CommandType.NEW_BID, args, callback));
            socket.on(CommandType.CLOSE_AUCTION, (args, callback) => this.onRequest(CommandType.CLOSE_AUCTION, args, callback));
        });

        this.protocolHttpServer.listen(11111);
        this.webHttpServer.listen(11112);

        // Connect to other nodes.
        this.otherNodes.forEach((host, id) => {
            let sock = io(host, {
                autoConnect: false,
                reconnection: true,
                reconnectionAttempts: 5,
                reconnectionDelay: 1000
            });

            sock.connect();

            let accepted = false;
            // let shutdown = false;

            sock.on("accept", () => {
                accepted = true;
            });

            sock.emitWithAck().then

            // sock.on("shutdown", () => {
            //     shutdown = true;
            // });

            sock.on("disconnect", (reason) => {
                if (reason === "server namespace disconnect") {         // Disconnected because not in configuration.
                    if (accepted) {
                        console.log("Server shutdown");
                    } else {
                        console.log("Connection refused by server.");
                    }
                } else {
                    console.log("Disconnected, attempting reconnection...");
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
            throw new error("Node is not active.");
        }

        this.debugLog("Stopping node...");

        // Disconnect the node to the database through its DBmanager.
        this.dbManager.disconnect();

        this.protocolHttpServer.close();
        this.protocolServer.close();
        this.protocolServer.disconnectSockets(true);

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

                    res = this.dbManager.queryAddNewUser(data.username, data.password);
                    break;
                }
                case CommandType.NEW_AUCTION: {
                    /** @type {AuctionCreateData} */
                    let data = logEntry.logData;

                    res = this.dbManager.queryAddNewAuction(data.user, data.startDate, data.objName, data.objDesc, data.startPrice);
                    break;
                }
                case CommandType.CLOSE_AUCTION: {
                    /** @type {AuctionCloseData} */
                    let data = logEntry.logData;

                    res = this.dbManager.queryCloseAuction(data.auctionId, data.closingDate);
                    break;
                }
                case CommandType.NEW_BID: {
                    /** @type {BidCreateData} */
                    let data = logEntry.logData;

                    res = this.dbManager.queryAddNewBid(data.user, data.auctionId, data.value);
                    break;
                }
                default: {
                    throw new error("Unknown command type '" + logEntry.commandType + "'");
                }
            }

            logEntry.callback(res); // Fulfill promise to web server by sending another promise.
        } else {
            throw new error("Log entry at index " + index + "is undefined.");
        }
    }

    /**
     * Handles incoming AppendEntries RPC messages.
     * @param {SocketCl} sender The socket representing the sender node.
     * @param {AppendEntriesParameters} args The parameters of the AppendEntries RPC.
     */
    onAppendEntriesMessage(sender, args) {
        if (args.term > this.currentTerm) {     // Contact from a more recent leader.
            switch (this.state) {
                case State.LEADER: {
                    this.stopHeartbeatTimeout();
                    break;
                }
                case State.CANDIDATE: {
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

            this.debugLog("New leader detected. Changing to %s state...", State.FOLLOWER);
        }

        switch (this.state) {
            case State.FOLLOWER: {
                if (args.isResponse) {
                    this.rpcManager.sendReplicationResponse(sender, this.currentTerm, false, this.commitIndex);
                    this.debugLog("Received \"%s\" response -> refused.", RPCType.APPENDENTRIES);
                    break;
                }

                if (args.term < this.currentTerm ||
                    this.log[args.prevLogIndex].term !== args.prevLogTerm) {
                    this.rpcManager.sendReplicationResponse(sender, this.currentTerm, false, this.commitIndex);
                    this.debugLog("Received %s message from previous term -> refused.", RPCType.APPENDENTRIES);
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

                if (args.leaderCommit > this.commitIndex) {
                    for (let i = this.commitIndex + 1; i <= lastIndex; i++) {   // Applies log entries to the database.
                        this.applyLogEntry(i);
                    }

                    this.debugLog("Committed %d log entries to database.", args.leaderCommit - this.commitIndex);
                    let lastIndex = args.prevLogIndex + args.entries.length;
                    this.commitIndex = lastIndex < args.leaderCommit ? lastIndex : args.leaderCommit;
                }

                this.rpcManager.sendReplicationResponse(sender, this.currentTerm, true, this.commitIndex);
                this.debugLog("Received \"%s\" request -> responded.", RPCType.APPENDENTRIES);
                this.resetLeaderTimeout();
            }
            case State.LEADER: {
                // This message is sent by an older leader and is no longer relevant.
                if (!args.isResponse) {
                    this.rpcManager.sendReplicationResponse(sender, this.currentTerm, false, this.commitIndex);
                    this.debugLog("Received \"%s\" request from previous term -> refused.", RPCType.APPENDENTRIES);
                }

                if (args.success) { // Leader was not rejected.
                    this.matchIndex.set(args.senderId, args.matchIndex);
                    this.nextIndex.set(args.senderId, args.matchIndex + 1);

                    let prevLogIndex = this.nextIndex[args.senderId] - 1;
                    let prevLogTerm = this.log[prevLogIndex];

                    // Sends missing entries to the node.
                    let missingEntries = this.log.slice(args.matchIndex + 1);
                    if (missingEntries.length > 0) {
                        this.rpcManager.sendReplicationTo(sender, this.currentTerm, prevLogIndex, prevLogTerm, missingEntries, this.commitIndex);
                        this.debugLog("Received successful \"%s\" response -> responded.", RPCType.APPENDENTRIES);
                        this.resetHeartbeatTimeout(args.senderId);
                    } 

                    // Server applies to the database the newly committed entries.
                    let sortedIndexes = [...this.matchIndex.values()].sort();
                    let oldCommitIndex = this.commitIndex;
                    
                    for(let i = sortedIndexes.length - 1; i >= 0; i--){
                        if(sortedIndexes.filter(index => index >= i).length > Math.floor(this.clusterSize / 2)){
                            this.commitIndex = sortedIndexes[i];
                            break;
                        }
                    }
                    
                    for(let i = oldCommitIndex + 1; i <= this.commitIndex; i++) {
                        this.applyLogEntry(i);
                    }
                } else {
                    this.debugLog("Received unsuccessful \"%s\" response -> ignored.", RPCType.APPENDENTRIES);
                }
                break; // Nothing is done if it's a log conflict, eventually a new election will start and the new leader fix things.
            }
            case State.CANDIDATE: {
                this.rpcManager.sendReplicationResponse(sender, this.currentTerm, false, this.commitIndex); // The message is for a previous term and it is rejected.
                this.debugLog("Received \"%s\" message from outdated term -> refused.", RPCType.APPENDENTRIES);
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
                case State.LEADER: {
                    this.stopHeartbeatTimeout();
                    break;
                }
                case State.CANDIDATE: {
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

            this.debugLog("New leader detected. Changing to %s state...", State.FOLLOWER);
        }

        switch (this.state) {
            case State.FOLLOWER: {
                if (this.votedFor == null) {
                    this.votedFor = args.senderId;
                    this.rpcManager.sendVote(sender, true);
                    this.debugLog("Received \"%s\" request -> cast vote.", RPCType.REQUESTVOTE);
                } else {
                    this.rpcManager.sendVote(sender, false);
                    this.debugLog("Received \"%s\" request -> refuse vote.", RPCType.REQUESTVOTE);
                }
                break;
            }
            case State.LEADER: {
                this.rpcManager.sendVote(sender, false);
                this.debugLog("Received \"%s\" request from loser candidate -> refuse vote.", RPCType.REQUESTVOTE);
                break;
            }
            case State.CANDIDATE: {
                if (args.isResponse) {
                    this.stopHeartbeatTimeout(args.senderId);
                    if (args.voteGranted) {
                        this.debugLog("Received vote confirmation. Votes obtained so far: %d.", this.votesGathered + 1);
                        if (this.votesGathered++ > Math.floor(this.clusterSize / 2)) {
                            this.debugLog("Majority obtained -> changing state to leader and notifying other nodes.");
                            this.state = State.LEADER;
                            this.rpcManager.sendReplication(this.term, this.log.length - 1, (node.log[-1] != null ? node.log[-1].term : null), [], this.commitIndex);
                            this.waitForHeartbeatTimeout();
                        }
                    } else {
                        this.debugLog("Received vote refusal.");
                    }
                } else {
                    this.rpcManager.sendVote(sender, false);
                    this.debugLog("Received \"%s\" request from another candidate -> refuse vote.", RPCType.REQUESTVOTE);
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

    /**
     * Set a timeout for communications from the leader.
     * 
     * In case the timeout expires, starts a new election as a candidate.
     */
    waitForLeaderTimeout() {
        let extractedInterval = this.minLeaderTimeout + Math.random * (this.maxLeaderTimeout - this.minLeaderTimeout);
        let node = this;
        this.leaderTimeout = setInterval(function startNewElection() {
            node.leaderTimeout = null; // Timeout has expired.
            this.debugLog("Leader timeout expired! Starting new election...");

            node.state = State.CANDIDATE;
            node.currentTerm++;
            node.currentLeaderId = null;
            votesGathered = 1;
            node.rpcManager.sendElectionNotice(node.currentTerm, node.id, node.log.length - 1, node.log[-1] != null ? node.log[-1].term : null);
            node.waitForElectionTimeout();  // Set a timeout in case the election doesn't end.
            node.waitForHeartbeatTimeout(); // Set a timeout in case other nodes do not respond.
        }, extractedInterval)
    }

    /**
     * Set a timeout for the current election.
     * 
     * In case the timeout expires, starts a new election as a candidate.
     */
    waitForElectionTimeout() {
        let extractedInterval = this.minElectionTimeout + Math.random * (this.maxElectionTimeout - this.minElectionTimeout);
        let node = this;
        this.electionTimeout = setInterval(function startNewElection() {
            node.electionTimeout = null; // Timeout has expired.
            this.debugLog("Election timeout expired! Starting new election...");

            node.state = State.CANDIDATE;
            node.currentTerm++;
            node.currentLeaderId = null;
            votesGathered = 1;
            node.rpcManager.sendElectionNotice(node.currentTerm, node.id, node.log.length - 1, node.log[-1] != null ? node.log[-1].term : null);
            node.waitForElectionTimeout();  // Set a timeout in case the new election doesn't end.
            node.waitForHeartbeatTimeout(); // Set a timeout in case other nodes do not respond.
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

        if (nodeId != null) { // The node is specified.
            if (thisNode.state === State.CANDIDATE) {  // The message sent is a vote request.
                sendHeartbeat = () => {
                    thisNode.heartbeatTimeouts.delete(nodeId); // Timeout has expired.
                    this.debugLog("Sending new heartbeat to node %s", nodeId);

                    thisNode.rpcManager.sendElectionNoticeTo(thisNode.sockets.get(nodeId), thisNode.term, thisNode.id, thisNode.log.length - 1, thisNode.log[-1] != null ? thisNode.log[-1].term : null);
                    thisNode.waitForHeartbeatTimeout(nodeId);
                };
            } else if (thisNode.state === State.LEADER) {    // The message sent is a replication request.
                sendHeartbeat = () => {
                    thisNode.heartbeatTimeouts.delete(nodeId); // Timeout has expired.
                    this.debugLog("Sending new heartbeat to node %s", nodeId);

                    let missingEntries = thisNode.log.slice(thisNode.matchIndex.get(nodeId) + 1);
                    let prevLogIndex = thisNode.nextIndex[nodeId] - 1;
                    let prevLogTerm = thisNode.log[prevLogIndex];
                    thisNode.rpcManager.sendReplicationTo(thisNode.sockets.get(nodeId), thisNode.term, prevLogIndex, prevLogTerm, missingEntries, thisNode.commitIndex + 1);
                    thisNode.waitForHeartbeatTimeout(nodeId);
                };
            } else { // Illegal state.
                throw new Error("Cannot send heartbeat when in state " + Object.entries(State).find(e => e[1] === thisNode.state).at(0));
            }

            // Starts the timeout.
            thisNode.heartbeatTimeouts.set(nodeId, setInterval(sendHeartbeat, thisNode.heartbeatTimeout));
        } else { // The node is unspecified.
            if (thisNode.state === State.CANDIDATE) {  // The message sent is a vote request.
                sendHeartbeat = (nodeId) => {
                    thisNode.heartbeatTimeouts.delete(nodeId); // Timeout has expired.
                    this.debugLog("Sending new heartbeat to node %s", nodeId);

                    thisNode.rpcManager.sendElectionNoticeTo(nodeId, thisNode.term, thisNode.id, thisNode.log.length - 1, thisNode.log[-1] != null ? thisNode.log[-1].term : null);
                    thisNode.waitForHeartbeatTimeout(nodeId);
                };
            } else if (thisNode.state === State.LEADER) {    // The message sent is a replication request.
                sendHeartbeat = (nodeId) => {
                    thisNode.heartbeatTimeouts.delete(nodeId); // Timeout has expired.
                    this.debugLog("Sending new heartbeat to node %s", nodeId);

                    let missingEntries = thisNode.log.slice(thisNode.matchIndex.get(nodeId) + 1);
                    let prevLogIndex = thisNode.nextIndex[nodeId] - 1;
                    let prevLogTerm = thisNode.log[prevLogIndex];
                    thisNode.rpcManager.sendReplicationTo(nodeId, thisNode.term, prevLogIndex, prevLogTerm, missingEntries, thisNode.commitIndex + 1);
                    thisNode.waitForHeartbeatTimeout(nodeId);
                };
            } else { // Illegal state.
                throw new Error("Cannot send heartbeat when in state " + Object.entries(State).find(e => e[1] === thisNode.state).at(0));
            }

            // Starts all the timeouts.
            this.heartbeatTimeouts.forEach((_, k) => {
                thisNode.heartbeatTimeouts.set(k, setInterval(() => sendHeartbeat(k), thisNode.heartbeatTimeout));
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
        clearInterval(this.leaderTimeout);
        this.leaderTimeout = null;
    }

    /**
     * Stops the election timeout, preventing a new election from starting.
    */
    stopElectionTimeout() {
        clearInterval(this.electionTimeout);
        this.electionTimeout = null;
    }

    /**
     * Stops the heartbeat timeout for a specific node or all nodes.
     * @param {String | null} nodeId - The ID of the node for which to stop the heartbeat timeout. If null, stops all timeouts.
    */
    stopHeartbeatTimeout(nodeId = null) {
        if (nodeId != null) {
            clearInterval(this.heartbeatTimeouts.get(nodeId));
            this.heartbeatTimeouts.delete(nodeId);
        } else {
            this.sockets.forEach((_, id) => {
                clearInterval(this.heartbeatTimeouts.get(id));
            });
            this.heartbeatTimeouts.clear();
        }
    }

    // Functions that handle the various requests that can be made on the database.
    // For every request add it on the log,  check the match index and reset the heartbeat timeout.
    onRequest(commandType, args, callback) {
        let prevLogIndex = this.log.length - 1;
        let prevLogTerm = this.log[-1] ? this.log[-1].term : null;

        switch (commandType) {
            case CommandType.NEW_USER: {
                this.log.push(new LogRecord(this.currentTerm, commandType, new UserCreateData(args.username, args.password), callback));
                break;
            }
            case CommandType.NEW_AUCTION: {
                this.log.push(new LogRecord(this.currentTerm, commandType, new AuctionCreateData(args.user, args.startDate, args.objName, args.objDesc, args.startPrice), callback));
                break;
            }
            case CommandType.NEW_BID: {
                this.log.push(new LogRecord(this.currentTerm, commandType, new BidCreateData(args.user, args.auctionId, args.value), callback));
                break;
            }
            case CommandType.CLOSE_AUCTION: {
                this.log.push(new LogRecord(this.currentTerm, commandType, new AuctionCloseData(args.auctionId, args.closingDate), callback));
                break;
            }
        }

        let node = this;
        this.matchIndex.forEach((i, nodeId) => {
            if (i == node.commitIndex) {
                this.rpcManager.sendReplicationTo(node.sockets.get(nodeId), node.currentTerm, prevLogIndex, prevLogTerm, [this.log[-1]], node.commitIndex);
                this.resetHeartbeatTimeout(nodeId);
            }
        });
    }

    debugLog(message, ...optionalParams) {
        if (this.debug) {
            console.log("[" + this.id + "]: " + message, optionalParams);
        }
    }
}