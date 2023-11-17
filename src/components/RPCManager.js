import { Socket as SocketCl } from 'socket.io-client';
import { RPCType } from '../enums/RPCType.js';
import { RPCParameters, AppendEntriesParameters, RequestVoteParameters, SnapshotParameters } from './RPCParameters.js';
import { Log } from './Log.js';

/**
 * Class containing the methods for sending RPCs to other nodes.
 */
export class RPCManager {

    /**
     * Creates an instance of the class.
     * @param {SocketCl[]} sockets Array of sockets for the other nodes.
     * @param {String} nodeId Id of the node linked to this manager instance.
     */
    constructor(sockets, nodeId){
        this.sockets = sockets;
        this.currentId = nodeId;
    }


    /**
     * 
     * @param {SocketCl} receiver Destination server. 
     * @param {String} rpcType 
     * @param {RPCParameters} rpcParameters
     * @returns {Boolean}
     */
    sendTo(receiver, rpcType, rpcParameters) {
        receiver.emit(rpcType, rpcParameters);
    }

    /**
     * 
     * @param {RPCType} rpcType 
     * @param {RPCParameters} rpcParameters 
     */
    sendAll(rpcType, rpcParameters) {
        this.sockets.forEach(s => {
            s.emit(rpcType, rpcParameters);
        })
    }

    /**
     * 
     * @param {Number} term 
     * @param {Number} prevLogIndex 
     * @param {Number} prevLogTerm 
     * @param {Log[]} entries 
     * @param {Number} leaderCommit 
     */
    sendReplication(term, prevLogIndex, prevLogTerm, entries, leaderCommit) {
        this.sendAll(RPCType.APPENDENTRIES, AppendEntriesParameters.forRequest(term, prevLogIndex, prevLogTerm, entries, leaderCommit));
    }
    
    /**
     * 
     * @param {SocketCl} receiver 
     * @param {Number} term 
     * @param {Boolean} success 
     * @param {Number} matchIndex 
     */
    sendReplicationResponse(receiver, term, success, matchIndex) {
        this.sendTo(receiver, AppendEntriesParameters.forResponse(term, success, matchIndex));
    }
    
    /**
     * 
     * @param {Number} term 
     * @param {Number} candidateId 
     * @param {Number} lastLogIndex 
     * @param {Number} lastLogTerm 
     */
    sendElectionNotice(term, candidateId, lastLogIndex, lastLogTerm) {
        this.sendAll(RPCType.REQUESTVOTE, RequestVoteParameters.forRequest(term, candidateId, lastLogIndex, lastLogTerm));
    }
    
    /**
     * 
     * @param {SocketCl} receiver 
     * @param {Boolean} voteGranted 
     */
    sendVote(receiver, voteGranted) {
        this.sendTo(receiver, RPCType.REQUESTVOTE, RequestVoteParameters.forResponse(term, voteGranted));
    }
    
    sendSnapshotMessage() {
        this.sendAll(RPCType.SNAPSHOT, SnapshotParameters.forRequest(/* ... */))
    } 

    sendSnapshotResponse(receiver) {
        this.sendTo(receiver, RPCType.SNAPSHOT, SnapshotParameters.forResponse(/* ... */))
    } 
}