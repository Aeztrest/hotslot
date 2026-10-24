// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice QuestSharded with the shards in a mapping instead of a fixed array.
///
/// Under MIP-8, storage is grouped into pages of 128 consecutive slots. `uint256[64]` occupies 64
/// consecutive slots, so all 64 shards of QuestSharded sit on one page: if Monad detects conflicts per
/// page, that sharding buys nothing. Mapping entries live at keccak256(key, slot), which scatters them
/// across pages, so the shards stay independent at either granularity.
///
/// Note the tension with MIP-8 gas: keeping hot data on one page is *cheaper* (later slots on a page
/// are warm), but it is exactly what concentrates conflicts.
contract QuestShardedMap {
    uint256 public constant SHARDS = 64;

    mapping(address => uint256) public points;
    mapping(uint256 => uint256) private shardCheckIns;

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
