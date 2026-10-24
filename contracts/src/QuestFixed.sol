// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Same features as QuestNaive, with no storage shared between players.
///
/// - points and check-in counts live under the player's own key, so two players never touch the
///   same slot;
/// - the global total and "last player" are not stored: they are derived from CheckedIn events,
///   which is how a frontend or indexer reads them anyway.
///
/// The cost: totalCheckIns() is no longer an on-chain view. If another contract needs it on-chain,
/// see QuestSharded for the middle ground.
contract QuestFixed {
    struct Player {
        uint128 points;
        uint64 checkIns;
        uint64 lastCheckInAt;
    }

    mapping(address => Player) public players;

    event CheckedIn(address indexed player, uint256 points, uint256 totalForPlayer);

    function checkIn() external {
        Player storage p = players[msg.sender];
        p.points += 10;
        p.checkIns += 1;
        p.lastCheckInAt = uint64(block.timestamp);
        emit CheckedIn(msg.sender, p.points, p.checkIns);
    }

    function points(address player) external view returns (uint256) {
        return players[player].points;
    }
}
