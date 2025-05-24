import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { BN } from 'bn.js';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

// Program ID for the zkcash program
const PROGRAM_ID = new PublicKey('BByY3XVe36QEn3omkkzZM7rst2mKqt4S4XMCrbM9oUTh');

// Configure connection to Solana devnet
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

// Constants from the Rust contract
const ROOT_HISTORY_SIZE = 100;
const DEFAULT_HEIGHT = 20;

/**
 * Script to check the current state of the Merkle tree
 * This shows the total number of UTXOs in the tree
 */
async function checkTreeState() {
  try {
    // Load wallet keypair from deploy-keypair.json in anchor directory
    let payer: Keypair;
    
    try {
      // Try to load from deploy-keypair.json in anchor directory
      const anchorDirPath = path.join(__dirname, '..', 'anchor');
      const deployKeypairPath = path.join(anchorDirPath, 'deploy-keypair.json');
      const keypairJson = JSON.parse(readFileSync(deployKeypairPath, 'utf-8'));
      payer = Keypair.fromSecretKey(Uint8Array.from(keypairJson));
      console.log('Using wallet address:', payer.publicKey.toString());
    } catch (err) {
      console.error('Could not load deploy-keypair.json from anchor directory');
      return;
    }
    
    // Derive PDA for the tree account
    const [treeAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from('merkle_tree'), payer.publicKey.toBuffer()],
      PROGRAM_ID
    );

    console.log('Tree Account Address:', treeAccount.toString());

    // Check if the program is initialized by fetching the tree account directly
    try {
      const treeAccountInfo = await connection.getAccountInfo(treeAccount);
      if (!treeAccountInfo) {
        throw new Error('Tree account not found');
      }
      
      console.log('Tree account found!');
      console.log('Account size:', treeAccountInfo.data.length, 'bytes');
      
      // Parse the account data manually
      const treeAccountData = {
        authority: new PublicKey(treeAccountInfo.data.slice(8, 40)),
        nextIndex: new BN(treeAccountInfo.data.slice(40, 48), 'le'),
        subtrees: Array.from({ length: DEFAULT_HEIGHT }, (_, i) => 
          treeAccountInfo.data.slice(48 + i * 32, 48 + (i + 1) * 32)
        ),
        root: treeAccountInfo.data.slice(48 + DEFAULT_HEIGHT * 32, 48 + DEFAULT_HEIGHT * 32 + 32),
        rootHistory: Array.from({ length: ROOT_HISTORY_SIZE }, (_, i) => 
          treeAccountInfo.data.slice(48 + DEFAULT_HEIGHT * 32 + 32 + i * 32, 48 + DEFAULT_HEIGHT * 32 + 32 + (i + 1) * 32)
        ),
        rootIndex: new BN(treeAccountInfo.data.slice(48 + DEFAULT_HEIGHT * 32 + 32 + ROOT_HISTORY_SIZE * 32, 48 + DEFAULT_HEIGHT * 32 + 32 + ROOT_HISTORY_SIZE * 32 + 8), 'le'),
        bump: treeAccountInfo.data[48 + DEFAULT_HEIGHT * 32 + 32 + ROOT_HISTORY_SIZE * 32 + 8],
        _padding: treeAccountInfo.data.slice(48 + DEFAULT_HEIGHT * 32 + 32 + ROOT_HISTORY_SIZE * 32 + 9)
      };
      
      // Display tree information with more clarity
      console.log('\n=== MERKLE TREE STATUS ===');
      console.log('Authority:', treeAccountData.authority.toString());
      console.log('Total UTXOs in tree:', treeAccountData.nextIndex.toString());
      console.log('Total deposits:', treeAccountData.nextIndex.div(new BN(2)).toString());
      
      // Current root information
      console.log('\n=== CURRENT ROOT INFORMATION ===');
      console.log('Root index in circular buffer:', treeAccountData.rootIndex.toString());
      
      // Handle large BN values that can't be represented as JavaScript number
      const currentRootIndex = treeAccountData.rootIndex.mod(new BN(ROOT_HISTORY_SIZE)).toNumber();
      console.log('Root index (modulo 100):', currentRootIndex);
      
      // Print total UTXOs
      console.log('\n=== DEPOSIT HISTORY ===');
      const totalDeposits = treeAccountData.nextIndex.div(new BN(2)).toNumber();
      console.log(`Total of ${totalDeposits} deposits have been made.`);
      console.log('Each deposit adds 2 UTXOs (one with value, one empty).');
      
      // Print the most recent roots in the history with better formatting
      console.log('\n=== RECENT ROOT HISTORY (LAST 10 DEPOSITS) ===');
      
      // Find 10 most recent roots
      const recentRoots = [];
      let idx = currentRootIndex;
      
      for (let i = 0; i < 10; i++) {
        recentRoots.push({
          index: idx,
          root: Buffer.from(treeAccountData.rootHistory[idx]).toString('hex'),
          isCurrent: idx === currentRootIndex
        });
        
        // Move to the previous index (wrapping around if needed)
        idx = (idx === 0) ? ROOT_HISTORY_SIZE - 1 : idx - 1;
      }
      
      // Print in reverse so the most recent root is last
      console.log('┌─────────────────┬──────────┬────────────────────────────────────────────────┐');
      console.log('│ Position        │ Root Idx │ Root Hash (first 8 bytes)                      │');
      console.log('├─────────────────┼──────────┼────────────────────────────────────────────────┤');
      
      recentRoots.reverse().forEach((item, i) => {
        const position = recentRoots.length - i;
        const rootPreview = item.root.substring(0, 16) + '...';
        const currentMarker = item.isCurrent ? '← CURRENT' : '';
        console.log(`│ ${position.toString().padEnd(15)} │ ${item.index.toString().padEnd(8)} │ ${rootPreview.padEnd(32)} ${currentMarker.padEnd(10)} │`);
      });
      
      console.log('└─────────────────┴──────────┴────────────────────────────────────────────────┘');
      
      // Show the full current root hash
      console.log('\nFull current root hash:');
      console.log(Buffer.from(treeAccountData.rootHistory[currentRootIndex]).toString('hex'));
      
    } catch (error) {
      console.error('Error fetching tree account:', error);
    }
  } catch (error) {
    console.error('Script error:', error);
  }
}

// Run the check function
checkTreeState()
  .then(() => console.log('\nTree status check completed'))
  .catch(err => console.error('Error running script:', err)); 