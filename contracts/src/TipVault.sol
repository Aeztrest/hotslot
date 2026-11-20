// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// A searcher-tip vault, written the usual EVM way. Searchers bid for the block and pay a tip to the
/// block's validator; stakers deposit MON and earn a share of the tips.
contract TipVault {
    // tips owed to each validator
    mapping(uint64 => uint256) public rewardsPayable;
    uint256 public totalTips;
    uint256 public bidCount;
    address public lastBidder;

    // staking side
    mapping(address => uint256) public shares;
    uint256 public totalShares;
    uint256 public totalAssets;

    constructor() payable {
        shares[msg.sender] = msg.value;
        totalShares = msg.value;
        totalAssets = msg.value;
    }

    function bid(uint64 validatorId) external payable {
        require(msg.value > 0, "no tip");
        rewardsPayable[validatorId] += msg.value;
        totalTips += msg.value;
        bidCount += 1;
        lastBidder = msg.sender;
    }

    function deposit() external payable {
        uint256 s = msg.value * totalShares / totalAssets;
        shares[msg.sender] += s;
        totalShares += s;
        totalAssets += msg.value;
    }

    function withdraw(uint256 s) external {
        uint256 assets = s * totalAssets / totalShares;
        shares[msg.sender] -= s;
        totalShares -= s;
        totalAssets -= assets;
        payable(msg.sender).transfer(assets);
    }
}
