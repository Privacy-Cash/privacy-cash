Trusted setup with done with 4 individuals: Zhe from Privacy Cash, Stan as a frontend contractor for Privacy Cash, Ilja and Richard from Tensor/Vector.

As long as one of those 4 people deleted one of the intermediate zkey files used to generate the final zkey file, the ZK setup is safe.

To get contributor and circuit hashes, run:
```
export NODE_OPTIONS="--max-old-space-size=8192" && npx snarkjs zkey verify transaction2.r1cs powersOfTau28_hez_final_18.ptau transaction2.zkey
```

You will see:
```
[INFO]  snarkJS: Circuit Hash:
		95a3ebe6 51cf2567 92d2eee4 67ce4857
		3c2c4f71 4644bb19 5581706b 1adf23a9
		bcb7a073 e6e8ec24 0be09fec 12744f94
		71a28551 5c976862 da704d3b 7898482a
[INFO]  snarkJS: -------------------------
[INFO]  snarkJS: contribution #4 Participant 4:
		2569ece5 b14bef9f 500dea69 d9137357
		7016563f aad63bbf 73296fe5 e4b28ebd
		d18f9ee2 5eb264d0 cabbedb6 6c3e5bee
		f3a2ee55 3c2d5ea4 65dd2701 1121d4e9
[INFO]  snarkJS: -------------------------
[INFO]  snarkJS: contribution #3 Participant 3:
		fa539138 565f8d52 f71753b7 95920836
		43761273 e1116168 2837ba6d 1138088a
		6f9b18d2 a4ea2ff5 7270554c fd833a18
		8bdd6d66 8338fe29 e6a797dd 443937a3
[INFO]  snarkJS: -------------------------
[INFO]  snarkJS: contribution #2 Participant 2:
		727d053f b471f33d bb994517 63a03a8f
		63ebcf5e 3dd9fe42 58209167 a3268e0d
		5fc60b37 84ac0b8c d91d4a10 04c47735
		66cf7af7 51a7c268 36ccb16a 2c2eb7af
[INFO]  snarkJS: -------------------------
[INFO]  snarkJS: contribution #1 Participant 1:
		d229b826 33ba9f58 d46f07c2 352bafa9
		f499b929 19a69ef0 042612db d272ac33
		8860c288 82afeacd 265f55af dccb2844
		b5120c2b 9b5411f0 773ec437 0a00450f
```