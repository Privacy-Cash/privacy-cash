import { 
  Connection, 
  Keypair, 
  PublicKey, 
  Transaction, 
  TransactionInstruction,
  sendAndConfirmTransaction,
  SystemProgram,
  ComputeBudgetProgram 
} from '@solana/web3.js';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { createHash } from 'crypto';

dotenv.config();

// Program ID for the zkcash program
const PROGRAM_ID = new PublicKey('BByY3XVe36QEn3omkkzZM7rst2mKqt4S4XMCrbM9oUTh');

// Configure connection to Solana devnet
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

// Calculate instruction discriminator for withdraw_fees
function getWithdrawFeesDiscriminator(): Buffer {
  const hash = createHash('sha256').update('global:withdraw_fees').digest();
  return hash.slice(0, 8); // First 8 bytes
}

// Load deploy keypair as the authority
function loadDeployKeypair(): Keypair {
  const deployKeypairPath = path.join(__dirname, '../anchor/deploy-keypair.json');
  try {
    const deployKeypairJson = JSON.parse(readFileSync(deployKeypairPath, 'utf-8'));
    return Keypair.fromSecretKey(Uint8Array.from(deployKeypairJson));
  } catch (error) {
    console.error('Failed to load deploy keypair:', error);
    throw new Error('Could not load deploy-keypair.json. Make sure it exists in the anchor directory.');
  }
}

// Create withdraw fees instruction
function createWithdrawFeesInstruction(
  authority: PublicKey,
  feeRecipientPDA: PublicKey,
  recipient: PublicKey,
  amount: number
): TransactionInstruction {
  // Get the correct discriminator
  const discriminator = getWithdrawFeesDiscriminator();
  
  // Serialize the amount as little-endian u64
  const amountBuffer = Buffer.allocUnsafe(8);
  amountBuffer.writeBigUInt64LE(BigInt(amount), 0);
  
  // Combine discriminator with amount
  const instructionData = Buffer.concat([
    discriminator,
    amountBuffer
  ]);

  console.log(`Instruction discriminator: ${discriminator.toString('hex')}`);
  console.log(`Amount buffer: ${amountBuffer.toString('hex')}`);
  console.log(`Full instruction data: ${instructionData.toString('hex')}`);

  return new TransactionInstruction({
    keys: [
      { pubkey: feeRecipientPDA, isSigner: false, isWritable: true },
      { pubkey: recipient, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data: instructionData,
  });
}

async function withdrawFees(recipientAddress: PublicKey, amountSOL?: number) {
  try {
    console.log('=== ZKCash Fee Withdrawal ===\n');
    
    // Load the deploy keypair (authority)
    const authority = loadDeployKeypair();
    console.log(`Authority (deploy keypair): ${authority.publicKey.toString()}`);
    console.log(`Recipient: ${recipientAddress.toString()}`);
    console.log(`Program ID: ${PROGRAM_ID.toString()}\n`);

    // Find the fee recipient PDA
    const [feeRecipientPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('fee_recipient'), authority.publicKey.toBuffer()],
      PROGRAM_ID
    );

    console.log(`Fee Recipient PDA: ${feeRecipientPDA.toString()}\n`);

    // Get current balances
    const feeRecipientBalance = await connection.getBalance(feeRecipientPDA);
    const recipientBalanceBefore = await connection.getBalance(recipientAddress);
    const authorityBalance = await connection.getBalance(authority.publicKey);

    console.log('=== Current Balances ===');
    console.log(`Fee Recipient: ${feeRecipientBalance.toLocaleString()} lamports (${(feeRecipientBalance / 1e9).toFixed(9)} SOL)`);
    console.log(`Withdrawal Recipient: ${recipientBalanceBefore.toLocaleString()} lamports (${(recipientBalanceBefore / 1e9).toFixed(9)} SOL)`);
    console.log(`Authority: ${authorityBalance.toLocaleString()} lamports (${(authorityBalance / 1e9).toFixed(9)} SOL)\n`);

    // Check if fee recipient account exists
    const feeRecipientAccountInfo = await connection.getAccountInfo(feeRecipientPDA);
    if (!feeRecipientAccountInfo) {
      console.error('❌ Fee recipient account not found. Please run the initialize script first.');
      return;
    }

    // Calculate withdrawal amount
    let withdrawalAmount: number;
    if (amountSOL !== undefined) {
      withdrawalAmount = Math.floor(amountSOL * 1e9); // Convert SOL to lamports
      console.log(`Requested withdrawal: ${amountSOL} SOL (${withdrawalAmount.toLocaleString()} lamports)`);
    } else {
      // Calculate rent exemption to keep the account alive
      const rentExemption = await connection.getMinimumBalanceForRentExemption(
        8 + 32 + 1 // FeeRecipientAccount: discriminator + authority + bump
      );
      withdrawalAmount = Math.max(0, feeRecipientBalance - rentExemption);
      console.log(`Withdrawing maximum available: ${(withdrawalAmount / 1e9).toFixed(9)} SOL (${withdrawalAmount.toLocaleString()} lamports)`);
      console.log(`Keeping rent exemption: ${(rentExemption / 1e9).toFixed(9)} SOL (${rentExemption.toLocaleString()} lamports)`);
    }

    // Validate withdrawal amount
    if (withdrawalAmount <= 0) {
      console.log('💸 No fees available for withdrawal.');
      return;
    }

    if (withdrawalAmount > feeRecipientBalance) {
      console.error(`❌ Insufficient funds. Requested ${withdrawalAmount.toLocaleString()} lamports but only ${feeRecipientBalance.toLocaleString()} available.`);
      return;
    }

    console.log(`\n=== Proceeding with withdrawal ===`);
    console.log(`Amount: ${(withdrawalAmount / 1e9).toFixed(9)} SOL (${withdrawalAmount.toLocaleString()} lamports)\n`);

    // Create withdraw fees instruction
    const withdrawFeesInstruction = createWithdrawFeesInstruction(
      authority.publicKey,
      feeRecipientPDA,
      recipientAddress,
      withdrawalAmount
    );

    // Set compute budget
    const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 200_000 
    });

    // Create transaction
    const transaction = new Transaction()
      .add(modifyComputeUnits)
      .add(withdrawFeesInstruction);

    // Send and confirm transaction
    console.log('Sending transaction...');
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [authority],
      {
        commitment: 'confirmed',
        maxRetries: 3
      }
    );

    console.log('✅ Fee withdrawal successful!');
    console.log(`Transaction signature: ${signature}`);
    console.log(`Transaction link: https://explorer.solana.com/tx/${signature}?cluster=devnet\n`);

    // Wait a moment for the transaction to be confirmed
    console.log('Waiting for confirmation...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Check final balances
    const feeRecipientBalanceAfter = await connection.getBalance(feeRecipientPDA);
    const recipientBalanceAfter = await connection.getBalance(recipientAddress);

    console.log('=== Final Balances ===');
    console.log(`Fee Recipient: ${feeRecipientBalanceAfter.toLocaleString()} lamports (${(feeRecipientBalanceAfter / 1e9).toFixed(9)} SOL)`);
    console.log(`Withdrawal Recipient: ${recipientBalanceAfter.toLocaleString()} lamports (${(recipientBalanceAfter / 1e9).toFixed(9)} SOL)\n`);

    console.log('=== Transfer Summary ===');
    const actualTransferred = recipientBalanceAfter - recipientBalanceBefore;
    const feeRecipientDecrease = feeRecipientBalance - feeRecipientBalanceAfter;
    console.log(`Transferred: ${(actualTransferred / 1e9).toFixed(9)} SOL (${actualTransferred.toLocaleString()} lamports)`);
    console.log(`Fee account decreased by: ${(feeRecipientDecrease / 1e9).toFixed(9)} SOL (${feeRecipientDecrease.toLocaleString()} lamports)`);

    if (actualTransferred === withdrawalAmount && feeRecipientDecrease === withdrawalAmount) {
      console.log('✅ Transfer completed successfully!');
    } else {
      console.log('⚠️  Transfer amounts don\'t match expected values. Please verify the transaction.');
    }

  } catch (error: any) {
    console.error('❌ Error during fee withdrawal:', error);
    
    if (error.message?.includes('0x1774')) {
      console.error('\n💡 This error indicates insufficient funds for withdrawal.');
    } else if (error.message?.includes('0x1770') || error.message?.includes('Unauthorized')) {
      console.error('\n💡 This error indicates unauthorized access. Make sure you\'re using the correct authority keypair.');
    } else if (error.message?.includes('blockhash')) {
      console.error('\n💡 This might be a network connectivity issue. Please try again.');
    } else if (error.message?.includes('Invalid public key')) {
      console.error('\n💡 Invalid public key format. Please check the addresses.');
    }
  }
}

// Parse command line arguments for recipient address and optional amount
function parseArgs(): { recipientAddress: PublicKey; amountSOL?: number } {
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.error('❌ Usage: npx ts-node withdraw_fees.ts <recipient_address> [amount_in_SOL]');
    console.error('Examples:');
    console.error('  npx ts-node withdraw_fees.ts EjusM5jooQkcfGFWrZPmzw9GeoxFpJKjdsSmHLQe3GYx        # Withdraw all available fees');
    console.error('  npx ts-node withdraw_fees.ts EjusM5jooQkcfGFWrZPmzw9GeoxFpJKjdsSmHLQe3GYx 0.1    # Withdraw 0.1 SOL');
    process.exit(1);
  }
  
  // Parse recipient address
  let recipientAddress: PublicKey;
  try {
    recipientAddress = new PublicKey(args[0]);
  } catch (error) {
    console.error('❌ Invalid recipient address. Please provide a valid Solana public key.');
    process.exit(1);
  }
  
  // Parse optional amount
  let amountSOL: number | undefined;
  if (args.length >= 2) {
    amountSOL = parseFloat(args[1]);
    if (isNaN(amountSOL) || amountSOL <= 0) {
      console.error('❌ Invalid amount. Please provide a positive number in SOL.');
      process.exit(1);
    }
  }
  
  if (args.length > 2) {
    console.error('❌ Too many arguments. Usage: npx ts-node withdraw_fees.ts <recipient_address> [amount_in_SOL]');
    process.exit(1);
  }
  
  return { recipientAddress, amountSOL };
}

// Export the function for potential reuse
export { withdrawFees };

// Run the function if this script is executed directly
if (require.main === module) {
  const { recipientAddress, amountSOL } = parseArgs();
  withdrawFees(recipientAddress, amountSOL);
} 