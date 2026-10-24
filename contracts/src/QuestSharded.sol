// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Keeps an on-chain global total without a single hot slot: the counter is split into
/// SHARDS slots and a caller only increments the shard picked by its address.
///
/// Two callers conflict only if they land in the same shard, so with N callers per block and S
/// shards roughly N^2 / 2S pairs still collide. More shards means fewer conflicts and a more
/// expensive totalCheckIns() read. hotslot simulate shows the trade-off directly.
contract QuestSharded {
    uint256 public constant SHARDS = 64;

    mapping(address => uint256) public points;
    uint256[SHARDS] private shardCheckIns;

    event CheckedIn(address indexed player, uint256 points);

    function checkIn() external {
        points[msg.sender] += 10;
        unchecked {
            shardCheckIns[uint160(msg.sender) % SHARDS] += 1;
        }
        emit CheckedIn(msg.sender, points[msg.sender]);
    }

    function totalCheckIns() external view returns (uint256 total) {
        for (uint256 i = 0; i < SHARDS; i++) total += shardCheckIns[i];
    }
}
