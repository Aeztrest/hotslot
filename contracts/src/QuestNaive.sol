// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice A daily check-in / points contract, written the way most EVM contracts are written:
/// global stats are kept up to date on every call.
///
/// On a sequential chain the extra global writes are just gas. On Monad, every checkIn() in a block
/// reads and writes `totalCheckIns` and `lastPlayer`, so each call depends on the one before it and
/// the block executes one transaction at a time.
contract QuestNaive {
    mapping(address => uint256) public points;

    uint256 public totalCheckIns;
    address public lastPlayer;
    uint256 public lastCheckInAt;

    event CheckedIn(address indexed player, uint256 points);

    function checkIn() external {
        points[msg.sender] += 10;
        totalCheckIns += 1;
        lastPlayer = msg.sender;
        lastCheckInAt = block.timestamp;
        emit CheckedIn(msg.sender, points[msg.sender]);
    }
}
