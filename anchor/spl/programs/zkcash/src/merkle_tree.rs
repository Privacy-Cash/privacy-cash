// Adapted from https://github.com/Lightprotocol/light-protocol/blob/b2a236409bb7797615d217fbf4fff498c852d25e/sparse-merkle-tree/src/merkle_tree.rs
use light_hasher::Hasher;
use crate::{MerkleTreeAccount, ErrorCode};
use anchor_lang::prelude::*;

pub struct MerkleTree;

impl MerkleTree {
    pub fn initialize<H: Hasher>(tree_account: &mut MerkleTreeAccount) -> Result<()> {
        let height = tree_account.height as usize;
        
        // Initialize empty subtrees
        let zero_bytes = H::zero_bytes();
        for i in 0..height {
            tree_account.subtrees[i] = zero_bytes[i];
        }

        // Set initial root
        let initial_root = H::zero_bytes()[height];
        tree_account.root = initial_root;
        tree_account.root_history[0] = initial_root;
        
        Ok(())
    }

    pub fn append<H: Hasher>(
        leaf: [u8; 32],
        tree_account: &mut MerkleTreeAccount,
    ) -> Result<Vec<[u8; 32]>> {
        let height = tree_account.height as usize;
        let root_history_size = tree_account.root_history_size as usize;
        
        // Check if tree is full before appending
        // Maximum capacity is 2^height leaves
        let max_capacity = 1u64 << height; // 2^height
        require!(
            tree_account.next_index < max_capacity,
            ErrorCode::MerkleTreeFull
        );

        let mut current_index = tree_account.next_index as usize;
        let mut current_level_hash = leaf;
        let mut left;
        let mut right;
        let mut proof: Vec<[u8; 32]> = vec![[0u8; 32]; height];

        for i in 0..height {
            let subtree = &mut tree_account.subtrees[i];
            let zero_byte = H::zero_bytes()[i];
            
            if current_index % 2 == 0 {
                left = current_level_hash;
                right = zero_byte;
                *subtree = current_level_hash;
                proof[i] = right;
            } else {
                left = *subtree;
                right = current_level_hash;
                proof[i] = left;
            }
            current_level_hash = H::hashv(&[&left, &right]).unwrap();
            current_index /= 2;
        }
        
        tree_account.root = current_level_hash;
        tree_account.next_index = tree_account.next_index
            .checked_add(1)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        
        let new_root_index = (tree_account.root_index as usize)
            .checked_add(1)
            .ok_or(ErrorCode::ArithmeticOverflow)? % root_history_size;
        tree_account.root_index = new_root_index as u64;
        tree_account.root_history[new_root_index] = current_level_hash;
        
        Ok(proof)
    }

    pub fn is_known_root(tree_account: &MerkleTreeAccount, root: [u8; 32]) -> bool {
        if root == [0u8; 32] {
            return false;
        }
        
        let root_history_size = tree_account.root_history_size as usize;
        let current_root_index = tree_account.root_index as usize;
        let mut i = current_root_index;
        
        loop {
            if root == tree_account.root_history[i] {
                return true;
            }
            
            if i == 0 {
                i = root_history_size - 1;
            } else {
                i -= 1;
            }
            
            if i == current_root_index {
                break;
            }
        }
        
        false
    }
} 