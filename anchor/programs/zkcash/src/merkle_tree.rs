use light_hasher::Hasher;
use crate::{MerkleTreeAccount, ErrorCode};
use anchor_lang::prelude::*;

pub const ROOT_HISTORY_SIZE: usize = 100;
pub const DEFAULT_HEIGHT: usize = 26;

pub struct MerkleTree;

impl MerkleTree {
    pub fn initialize<H: Hasher>(tree_account: &mut MerkleTreeAccount) {
        // Initialize empty subtrees
        let zero_bytes = H::zero_bytes();
        for i in 0..DEFAULT_HEIGHT {
            tree_account.subtrees[i] = zero_bytes[i];
        }

        // Set initial root
        let initial_root = H::zero_bytes()[DEFAULT_HEIGHT];
        tree_account.root = initial_root;
        tree_account.root_history[0] = initial_root;
    }

    pub fn append<H: Hasher>(
        leaf: [u8; 32],
        tree_account: &mut MerkleTreeAccount,
    ) -> Result<[[u8; 32]; DEFAULT_HEIGHT]> {
        let mut current_index = tree_account.next_index as usize;
        let mut current_level_hash = leaf;
        let mut left;
        let mut right;
        let mut proof: [[u8; 32]; DEFAULT_HEIGHT] = [[0u8; 32]; DEFAULT_HEIGHT];

        for (i, (subtree, zero_byte)) in tree_account.subtrees
            .iter_mut()
            .zip(H::zero_bytes().iter())
            .enumerate()
        {
            if current_index % 2 == 0 {
                left = current_level_hash;
                right = *zero_byte;
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
            .ok_or(ErrorCode::ArithmeticOverflow)? % ROOT_HISTORY_SIZE;
        tree_account.root_index = new_root_index as u64;
        tree_account.root_history[new_root_index] = current_level_hash;
        
        Ok(proof)
    }

    pub fn is_known_root(tree_account: &MerkleTreeAccount, root: [u8; 32]) -> bool {
        if root == [0u8; 32] {
            return false;
        }
        
        let current_root_index = tree_account.root_index as usize;
        let mut i = current_root_index;
        
        loop {
            if root == tree_account.root_history[i] {
                return true;
            }
            
            if i == 0 {
                i = ROOT_HISTORY_SIZE - 1;
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