#!/bin/bash -e
# Multi-Party Trusted Setup Ceremony for Privacy Cash
# This script coordinates a 10-person trusted setup ceremony

CIRCUIT_NUM=${1:-2}
COMMAND=${2:-setup}
PARTICIPANT_NUM=${3:-1}
ARTIFACTS_DIR="../artifacts/circuits"
CEREMONY_DIR="./ceremony_${CIRCUIT_NUM}"

echo "===== Multi-Party Trusted Setup Ceremony ====="
echo "Circuit: transaction${CIRCUIT_NUM}.circom"
echo "Command: ${COMMAND}"
if [ "$COMMAND" = "contribute" ]; then
    echo "Participant: ${PARTICIPANT_NUM}"
fi
echo "=============================================="

# Create ceremony directory
mkdir -p "$CEREMONY_DIR"

case "$COMMAND" in
    "setup"|"")
        # Check if we have the compiled circuit
        if [ ! -f "$ARTIFACTS_DIR/transaction${CIRCUIT_NUM}.r1cs" ]; then
            echo "❌ Circuit not compiled. Please run: ./buildCircuit_prod_solana.sh ${CIRCUIT_NUM}"
            exit 1
        fi

        # Check if we have Powers of Tau
        PTAU_FILE="powersOfTau28_hez_final_18.ptau"
        if [ ! -f "$ARTIFACTS_DIR/$PTAU_FILE" ]; then
            echo "❌ Powers of Tau file not found. Please run buildCircuit_prod_solana.sh first."
            exit 1
        fi

        echo "🚀 Starting ceremony setup..."

        # Phase 1: Initial setup (done by coordinator)
        echo "[PHASE 1] Creating initial setup..."
        npx snarkjs groth16 setup \
            "$ARTIFACTS_DIR/transaction${CIRCUIT_NUM}.r1cs" \
            "$ARTIFACTS_DIR/$PTAU_FILE" \
            "$CEREMONY_DIR/transaction${CIRCUIT_NUM}_initial.zkey"

        echo "✅ Initial setup complete: transaction${CIRCUIT_NUM}_initial.zkey"

        echo ""
        echo "📋 CEREMONY INSTRUCTIONS:"
        echo "=========================="
        echo ""
        echo "1. COORDINATOR (you) should now share the following files with each participant:"
        echo "   - $CEREMONY_DIR/transaction${CIRCUIT_NUM}_initial.zkey"
        echo "   - This ceremony script"
        echo ""
        echo "2. PARTICIPANT 1 should run:"
        echo "   ./trusted_setup_ceremony.sh ${CIRCUIT_NUM} contribute 1"
        echo ""
        echo "3. PARTICIPANT 2 should run:"
        echo "   ./trusted_setup_ceremony.sh ${CIRCUIT_NUM} contribute 2"
        echo ""
        echo "4. PARTICIPANT 3 should run:"
        echo "   ./trusted_setup_ceremony.sh ${CIRCUIT_NUM} contribute 3"
        echo ""
        echo "5. PARTICIPANT 4 should run:"
        echo "   ./trusted_setup_ceremony.sh ${CIRCUIT_NUM} contribute 4"
        echo ""
        echo "6. PARTICIPANT 5 should run:"
        echo "   ./trusted_setup_ceremony.sh ${CIRCUIT_NUM} contribute 5"
        echo ""
        echo "7. PARTICIPANT 6 should run:"
        echo "   ./trusted_setup_ceremony.sh ${CIRCUIT_NUM} contribute 6"
        echo ""
        echo "8. PARTICIPANT 7 should run:"
        echo "   ./trusted_setup_ceremony.sh ${CIRCUIT_NUM} contribute 7"
        echo ""
        echo "9. PARTICIPANT 8 should run:"
        echo "   ./trusted_setup_ceremony.sh ${CIRCUIT_NUM} contribute 8"
        echo ""
        echo "10. PARTICIPANT 9 should run:"
        echo "   ./trusted_setup_ceremony.sh ${CIRCUIT_NUM} contribute 9"
        echo ""
        echo "11. PARTICIPANT 10 should run:"
        echo "   ./trusted_setup_ceremony.sh ${CIRCUIT_NUM} contribute 10"
        echo ""
        echo "12. After all contributions, COORDINATOR should run:"
        echo "   ./trusted_setup_ceremony.sh ${CIRCUIT_NUM} finalize"
        echo ""
        echo "🔐 SECURITY REMINDER:"
        echo "Each participant MUST delete their contribution files after passing to the next person!"
        ;;

    "contribute")
        echo "🎯 PARTICIPANT ${PARTICIPANT_NUM} CONTRIBUTION"
        echo "============================================="
        
        # Determine input and output files
        if [ "$PARTICIPANT_NUM" = "1" ]; then
            INPUT_FILE="$CEREMONY_DIR/transaction${CIRCUIT_NUM}_initial.zkey"
        else
            PREV_PARTICIPANT=$((PARTICIPANT_NUM - 1))
            INPUT_FILE="$CEREMONY_DIR/transaction${CIRCUIT_NUM}_participant${PREV_PARTICIPANT}.zkey"
        fi
        
        OUTPUT_FILE="$CEREMONY_DIR/transaction${CIRCUIT_NUM}_participant${PARTICIPANT_NUM}.zkey"
        
        # Check if input file exists
        if [ ! -f "$INPUT_FILE" ]; then
            echo "❌ Input file not found: $INPUT_FILE"
            echo ""
            if [ "$PARTICIPANT_NUM" = "1" ]; then
                echo "This means the coordinator hasn't run setup yet, or you don't have the initial file."
                echo ""
                echo "SOLUTION:"
                echo "1. Coordinator should first run: ./trusted_setup_ceremony.sh $CIRCUIT_NUM setup"
                echo "2. Coordinator should share: ceremony_$CIRCUIT_NUM/transaction${CIRCUIT_NUM}_initial.zkey"
                echo "3. Place the received file in: $INPUT_FILE"
            else
                echo "Please get the file from the previous participant (Participant $((PARTICIPANT_NUM - 1)))."
            fi
            exit 1
        fi
        
        echo "📥 Input file: $(basename $INPUT_FILE)"
        echo "📤 Output file: $(basename $OUTPUT_FILE)"
        echo ""
        echo "⚠️  CRITICAL SECURITY NOTICE:"
        echo "You are about to contribute randomness to the trusted setup."
        echo "After this process, you MUST:"
        echo "1. Send $(basename $OUTPUT_FILE) to the next participant"
        echo "2. DELETE $(basename $INPUT_FILE) immediately"
        echo "3. Never share your contribution entropy with anyone"
        echo ""
        read -p "Press Enter to continue with your contribution..."
        
        # Generate random entropy for this participant
        echo "🎲 Generating contribution entropy..."
        ENTROPY="Participant ${PARTICIPANT_NUM} - $(date) - $(openssl rand -hex 32)"
        
        # Make the contribution
        echo "🔄 Making contribution (this may take several minutes)..."
        echo "$ENTROPY" | npx snarkjs zkey contribute \
            "$INPUT_FILE" \
            "$OUTPUT_FILE" \
            --name="Participant ${PARTICIPANT_NUM}"
        
        echo "✅ Contribution complete!"
        echo ""
        echo "📋 NEXT STEPS FOR PARTICIPANT ${PARTICIPANT_NUM}:"
        echo "================================================"
        echo "1. Send this file to the next participant: $(basename $OUTPUT_FILE)"
        if [ "$PARTICIPANT_NUM" = "10" ]; then
            echo "   (You're the last participant - send to coordinator for finalization)"
        else
            NEXT_PARTICIPANT=$((PARTICIPANT_NUM + 1))
            echo "   (Send to Participant ${NEXT_PARTICIPANT})"
        fi
        echo "2. 🚨 DELETE this file immediately: $(basename $INPUT_FILE)"
        echo "3. Never share your entropy or intermediate files"
        echo ""
        echo "🔍 Verification info:"
        npx snarkjs zkey verify \
            "$ARTIFACTS_DIR/transaction${CIRCUIT_NUM}.r1cs" \
            "$ARTIFACTS_DIR/powersOfTau28_hez_final_18.ptau" \
            "$OUTPUT_FILE"
        ;;

    "finalize")
        echo "🏁 FINALIZING CEREMONY"
        echo "======================"
        
        FINAL_INPUT="$CEREMONY_DIR/transaction${CIRCUIT_NUM}_participant10.zkey"
        FINAL_OUTPUT="$ARTIFACTS_DIR/transaction${CIRCUIT_NUM}.zkey"
        VERIFICATION_KEY="$ARTIFACTS_DIR/verifyingkey${CIRCUIT_NUM}.json"
        
        # Check if final contribution exists
        if [ ! -f "$FINAL_INPUT" ]; then
            echo "❌ Final participant contribution not found: $FINAL_INPUT"
            exit 1
        fi
        
        echo "📁 Using final contribution: $(basename $FINAL_INPUT)"
        echo "📤 Creating final proving key: $(basename $FINAL_OUTPUT)"
        echo "📤 Creating verification key: $(basename $VERIFICATION_KEY)"
        
        # Copy the final contribution to the artifacts directory
        cp "$FINAL_INPUT" "$FINAL_OUTPUT"
        
        # Export verification key
        npx snarkjs zkey export verificationkey "$FINAL_OUTPUT" "$VERIFICATION_KEY"
        
        echo "✅ Ceremony finalized!"
        echo ""
        echo "🔍 Final verification:"
        npx snarkjs zkey verify \
            "$ARTIFACTS_DIR/transaction${CIRCUIT_NUM}.r1cs" \
            "$ARTIFACTS_DIR/powersOfTau28_hez_final_18.ptau" \
            "$FINAL_OUTPUT"
        
        echo ""
        echo "📊 Circuit information:"
        npx snarkjs info -r "$ARTIFACTS_DIR/transaction${CIRCUIT_NUM}.r1cs"
        
        echo ""
        echo "🎉 TRUSTED SETUP CEREMONY COMPLETED! 🎉"
        echo "========================================"
        echo "Final files created:"
        echo "- Proving key: $FINAL_OUTPUT"
        echo "- Verification key: $VERIFICATION_KEY"
        echo ""
        echo "🧹 Cleanup recommendation:"
        echo "You can now delete the ceremony directory: $CEREMONY_DIR"
        ;;

    *)
        echo "❌ Unknown command: $COMMAND"
        echo ""
        echo "Usage:"
        echo "  $0 [circuit_num] setup               # Start ceremony (coordinator)"
        echo "  $0 [circuit_num] contribute [1-10]   # Make contribution (participants)"
        echo "  $0 [circuit_num] finalize            # Finalize ceremony (coordinator)"
        echo ""
        echo "Example:"
        echo "  $0 2 setup          # Start ceremony for transaction2.circom"
        echo "  $0 2 contribute 1   # Participant 1 contributes"
        echo "  $0 2 contribute 2   # Participant 2 contributes"
        echo "  $0 2 contribute 3   # Participant 3 contributes"
        echo "  $0 2 contribute 4   # Participant 4 contributes"
        echo "  $0 2 contribute 5   # Participant 5 contributes"
        echo "  $0 2 contribute 6   # Participant 6 contributes"
        echo "  $0 2 contribute 7   # Participant 7 contributes"
        echo "  $0 2 contribute 8   # Participant 8 contributes"
        echo "  $0 2 contribute 9   # Participant 9 contributes"
        echo "  $0 2 contribute 10  # Participant 10 contributes"
        echo "  $0 2 finalize       # Coordinator finalizes"
        exit 1
        ;;
esac 