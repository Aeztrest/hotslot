// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Constant-product pool (MON -> token). Every buy reads and writes the reserves, and the
/// amount out is computed from them: buy #2's price depends on buy #1. This conflict is inherent;
/// no storage layout removes it. Included so the report shows the tool telling the two cases apart.
contract MiniPool {
    uint256 public reserveMon;
    uint256 public reserveToken;
    mapping(address => uint256) public tokenBalance;

    constructor() payable {
        reserveMon = msg.value;
        reserveToken = 1_000_000 ether;
    }

    function buy(uint256 minOut) external payable returns (uint256 out) {
        out = (reserveToken * msg.value) / (reserveMon + msg.value);
        require(out >= minOut, "slippage");
        reserveMon += msg.value;
        reserveToken -= out;
        tokenBalance[msg.sender] += out;
    }
}
