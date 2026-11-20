// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Bids debit a balance the bidder prefunded, so a bid moves no MON and touches only the bidder's slots.
contract TipVaultEscrow {
    mapping(address => uint256) public balanceOf;
    mapping(uint64 => mapping(address => uint256)) public owed;

    event Bid(address indexed bidder, uint64 indexed validatorId, uint256 amount);

    function fund() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function bid(uint64 validatorId, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        owed[validatorId][msg.sender] += amount;
        emit Bid(msg.sender, validatorId, amount);
    }
}
