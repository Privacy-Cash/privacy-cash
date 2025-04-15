use std::marker::PhantomData;

use light_hasher::Hasher;

/// Inspired by Sparse Merkle Tree implementation in https://github.com/Lightprotocol/light-protocol/blob/2563f19f80d90ad04a2bdd351e2dfe80f7d8068d/program-tests/merkle-tree/src/sparse_merkle_tree.rs#L7
const ROOT_HISTORY_SIZE: usize = 100;

#[derive(Clone, Debug)]
pub struct SparseMerkleTreeWithHistory<H: Hasher, const HEIGHT: usize> {
    subtrees: [[u8; 32]; HEIGHT],
    // index of the next leaf to be inserted
    next_index_to_insert: usize,
    root: [u8; 32],
    root_history: [[u8; 32]; ROOT_HISTORY_SIZE],
    current_root_index: usize,
    _hasher: PhantomData<H>,
}

impl<H, const HEIGHT: usize> SparseMerkleTreeWithHistory<H, HEIGHT>
where
    H: Hasher,
{
    pub fn new_empty() -> Self {
        let initial_root = H::zero_bytes()[HEIGHT];
        let mut root_history = [[0u8; 32]; ROOT_HISTORY_SIZE];
        root_history[0] = initial_root;
        
        Self {
            subtrees: H::zero_bytes()[0..HEIGHT].try_into().unwrap(),
            next_index_to_insert: 0,
            root: initial_root,
            root_history,
            current_root_index: 0,
            _hasher: PhantomData,
        }
    }

    pub fn append(&mut self, leaf: [u8; 32]) -> [[u8; 32]; HEIGHT] {
        let mut current_index = self.next_index_to_insert;
        let mut current_level_hash = leaf;
        let mut left;
        let mut right;
        let mut proof: [[u8; 32]; HEIGHT] = [[0u8; 32]; HEIGHT];

        for (i, (subtree, zero_byte)) in self
            .subtrees
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
        self.root = current_level_hash;
        self.next_index_to_insert += 1;
        
        let new_root_index = (self.current_root_index + 1) % ROOT_HISTORY_SIZE;
        self.current_root_index = new_root_index;
        self.root_history[new_root_index] = current_level_hash;
        
        proof
    }

    pub fn root(&self) -> [u8; 32] {
        self.root
    }

    pub fn get_root_history(&self) -> [[u8; 32]; ROOT_HISTORY_SIZE] {
        self.root_history
    }

    pub fn get_current_root_index(&self) -> usize {
        self.current_root_index
    }
    
    pub fn get_subtrees(&self) -> [[u8; 32]; HEIGHT] {
        self.subtrees
    }

    pub fn get_height(&self) -> usize {
        HEIGHT
    }

    pub fn get_next_index(&self) -> usize {
        self.next_index_to_insert
    }
    
}