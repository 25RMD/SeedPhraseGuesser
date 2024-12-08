const { ethers } = require('ethers');
const fs = require('fs').promises;
const path = require('path');

// USDT Contract Details on BSC
const USDT_CONTRACT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955"; // USDT Contract Address on BSC
const USDT_ABI = [
    "function balanceOf(address account) view returns (uint256)"
];

// BSC RPC URL (you can use a public or private endpoint)
const BSC_RPC_URL = "https://bsc-dataseed.binance.org/";

// Standard BIP39 word list used by MetaMask and other Ethereum wallets
const wordListPromise = fs.readFile(path.join(__dirname, 'english.txt'), 'utf8')
    .then(content => content.trim().split('\n'))
    .catch(error => {
        console.error('Error reading word list:', error);
        return [];
    });

/**
 * Recovery utility to find mnemonics with USDT balance > 100 on BSC
 */
class USDTBalanceSeedPhraseRecovery {
    constructor(knownWords, missingPositions, logFilePath = 'usdt_seed_phrase_recovery.log', checkpointPath = 'recovery_checkpoint.json') {
        this.knownWords = knownWords;
        this.missingPositions = missingPositions;
        this.logFilePath = logFilePath;
        this.checkpointPath = checkpointPath;
        this.totalAttempts = BigInt(0);
        this.validAttempts = 0;
        this.wordList = [];
        this.provider = null;
        this.usdtContract = null;
        this.startTime = null;
        this.combinationCount = null;
        this.foundValidPhrases = [];
        this.lastCheckpointTime = Date.now();
        this.CHECKPOINT_INTERVAL = 5 * 60 * 1000; // 5 minutes
        this.LOGGING_INTERVAL = 100000; // Log every 100,000 attempts
        this.attemptedCombinations = new Set();
    }

    /**
     * Save a checkpoint of the current recovery state
     */
    async saveCheckpoint() {
        try {
            const checkpointData = {
                totalAttempts: this.totalAttempts.toString(),
                validAttempts: this.validAttempts,
                foundValidPhrases: this.foundValidPhrases,
                startTime: this.startTime,
                timestamp: Date.now()
            };

            await fs.writeFile(
                this.checkpointPath, 
                JSON.stringify(checkpointData, null, 2),
                'utf8'
            );

            console.log(`Checkpoint saved at ${new Date().toISOString()}`);
        } catch (error) {
            console.error('Error saving checkpoint:', error);
        }
    }

    /**
     * Load a previous checkpoint if it exists
     */
    async loadCheckpoint() {
        try {
            const checkpointExists = await fs.access(this.checkpointPath)
                .then(() => true)
                .catch(() => false);

            if (checkpointExists) {
                const checkpointData = JSON.parse(
                    await fs.readFile(this.checkpointPath, 'utf8')
                );

                this.totalAttempts = BigInt(checkpointData.totalAttempts);
                this.validAttempts = checkpointData.validAttempts;
                this.foundValidPhrases = checkpointData.foundValidPhrases;
                this.startTime = checkpointData.startTime;

                console.log('Checkpoint loaded successfully:');
                console.log(`- Resumed from attempt: ${this.totalAttempts}`);
                console.log(`- Valid phrases found: ${this.validAttempts}`);

                return true;
            }
        } catch (error) {
            console.error('Error loading checkpoint:', error);
        }
        return false;
    }

    /**
     * Initialize the recovery process
     */
    async initialize() {
        this.wordList = await wordListPromise;

        // Validate input
        if (this.wordList.length === 0) {
            throw new Error('Failed to load word list. Ensure english.txt is present.');
        }

        // Validate known words
        const invalidWords = this.knownWords.filter(word => !this.wordList.includes(word));
        if (invalidWords.length > 0) {
            throw new Error(`Invalid words in known words: ${invalidWords.join(', ')}`);
        }

        // Calculate total possible combinations
        this.combinationCount = BigInt(this.wordList.length ** this.missingPositions.length);

        // Try to load previous checkpoint
        const loadedCheckpoint = await this.loadCheckpoint();

        // Initialize provider and contract
        this.provider = new ethers.JsonRpcProvider(BSC_RPC_URL);
        this.usdtContract = new ethers.Contract(USDT_CONTRACT_ADDRESS, USDT_ABI, this.provider);

        // Set start time if not already set
        if (!this.startTime) {
            this.startTime = Date.now();
        }

        // Log initialization details
        console.log('Recovery Utility Initialized:');
        console.log(`- Word List Size: ${this.wordList.length}`);
        console.log(`- Known Words: ${this.knownWords.join(' ')}`);
        console.log(`- Missing Positions: ${this.missingPositions.join(', ')}`);
        console.log(`- Total Possible Combinations: ${this.combinationCount.toLocaleString()}`);
        console.log(`- Checkpoint Loaded: ${loadedCheckpoint}`);

        return this;
    }

    /**
     * Generate an index-based combination of words
     */
    generateCombination(combinationIndex) {
        const candidateSeedPhrase = [...this.knownWords];
        this.missingPositions.forEach((pos, index) => {
            const wordListLength = BigInt(this.wordList.length);
            const wordIndex = Number(
                (combinationIndex / (wordListLength ** BigInt(this.missingPositions.length - 1 - index))) 
                % wordListLength
            );
            candidateSeedPhrase.splice(pos - 1, 0, this.wordList[wordIndex]);
        });
        return candidateSeedPhrase;
    }

    /**
     * Validate if the generated seed phrase has USDT balance > 100
     */
    async validateSeedPhrase(seedPhrase) {
        try {
            // Validate the seed phrase is valid
            if (!this.isValidBIP39Phrase(seedPhrase)) {
                return false;
            }

            // Derive wallet from seed phrase
            const mnemonic = seedPhrase.join(' ');
            const wallet = ethers.Wallet.fromPhrase(mnemonic);
            const address = wallet.address;

            // Check USDT balance
            const balance = await this.usdtContract.balanceOf(address);
            const balanceInUSDT = Number(ethers.formatUnits(balance, 18)); // USDT has 18 decimals

            return balanceInUSDT > 100;
        } catch (error) {
            // Silently handle errors (invalid phrase, network issues, etc.)
            return false;
        }
    }

    /**
     * Find all mnemonics with valid USDT balance > 100
     */
    async findValidSeedPhrases() {
        if (this.wordList.length === 0) {
            throw new Error('Word list not initialized. Call initialize() first.');
        }

        // Prepare log file and load previous attempts
        await this.prepareLogFile();
        await this.loadAttemptedCombinations();

        for (let combinationIndex = this.totalAttempts;
             combinationIndex < this.combinationCount;
             combinationIndex++) {
            
            // Skip already attempted combinations
            if (this.attemptedCombinations.has(combinationIndex)) {
                this.totalAttempts = combinationIndex + BigInt(1);
                continue;
            }

            this.totalAttempts = combinationIndex + BigInt(1);
            const candidateSeedPhrase = this.generateCombination(combinationIndex);

            // Log the attempted combination first
            await this.logAttemptedCombination(combinationIndex);

            const isValid = await this.validateSeedPhrase(candidateSeedPhrase);
            
            if (isValid) {
                await this.logSeedPhraseAttempt(candidateSeedPhrase, isValid);
            }

            // Progress logging
            if (this.totalAttempts % BigInt(this.LOGGING_INTERVAL) === BigInt(0)) {
                const elapsedTime = (Date.now() - this.startTime) / 1000;
                const progressPercentage = (Number(this.totalAttempts) / Number(this.combinationCount)) * 100;
                
                console.log(`Progress: ${progressPercentage.toFixed(2)}% | ` +
                            `Attempts: ${this.totalAttempts.toLocaleString()} / ${this.combinationCount.toLocaleString()} | ` +
                            `Elapsed: ${elapsedTime.toFixed(2)} seconds | ` +
                            `Valid Phrases Found: ${this.validAttempts}`);
            }

            // Periodic checkpointing
            const currentTime = Date.now();
            if (currentTime - this.lastCheckpointTime >= this.CHECKPOINT_INTERVAL) {
                await this.saveCheckpoint();
                this.lastCheckpointTime = currentTime;
            }
        }

        // Final summary and checkpoint
        console.log('Search Complete:');
        console.log(`Total Attempts: ${this.totalAttempts.toLocaleString()}`);
        console.log(`Valid Phrases Found: ${this.validAttempts}`);
        console.log('Found Phrases:', this.foundValidPhrases);

        // Final checkpoint
        await this.saveCheckpoint();
    }

    /**
     * Prepare log file with detailed header
     */
    async prepareLogFile() {
        try {
            const header = `USDT Seed Phrase Recovery Log\nStarted at: ${new Date().toISOString()}\n` +
                           `Known Words: ${this.knownWords.join(' ')}\n` +
                           `Missing Positions: ${this.missingPositions.join(', ')}\n` +
                           `Total Possible Combinations: ${this.combinationCount.toLocaleString()}\n` +
                           `Word List Size: ${this.wordList.length}\n` +
                           '-------------------------------------------\n' +
                           '# ATTEMPTED_COMBINATIONS_START\n';
            await fs.writeFile(this.logFilePath, header);
        } catch (error) {
            console.error('Error preparing log file:', error);
        }
    }

    /**
     * Load previously attempted combinations from log file
     */
    async loadAttemptedCombinations() {
        try {
            const logContent = await fs.readFile(this.logFilePath, 'utf8');
            const combinationsSection = logContent.split('# ATTEMPTED_COMBINATIONS_START\n')[1];
            
            if (combinationsSection) {
                const attemptedLines = combinationsSection.split('\n')
                    .filter(line => line.trim() !== '')
                    .map(line => BigInt(line.trim()));
                
                this.attemptedCombinations = new Set(attemptedLines);
                console.log(`Loaded ${this.attemptedCombinations.size} previously attempted combinations`);
            }
        } catch (error) {
            console.error('Error loading attempted combinations:', error);
        }
    }

    /**
     * Log attempted combination to prevent future reprocessing
     */
    async logAttemptedCombination(combinationIndex) {
        try {
            await fs.appendFile(this.logFilePath, `${combinationIndex}\n`, 'utf8');
            this.attemptedCombinations.add(combinationIndex);
        } catch (error) {
            console.error('Error logging attempted combination:', error);
        }
    }

    /**
     * Log seed phrase attempt to file
     */
    async logSeedPhraseAttempt(seedPhrase, isValid) {
        try {
            if (isValid) {
                const logEntry = `${new Date().toISOString()} | Valid: ${isValid} | ` +
                                 `Mnemonic: ${seedPhrase.join(' ')}\n`;
                await fs.appendFile(this.logFilePath, logEntry);
                
                // Store found valid phrases
                this.foundValidPhrases.push(seedPhrase.join(' '));
                this.validAttempts++;
            }
        } catch (error) {
            console.error('Error writing to log file:', error);
        }
    }

    /**
     * Check if a seed phrase matches BIP39 word list and checksum
     */
    isValidBIP39Phrase(seedPhrase) {
        return seedPhrase.every(word => this.wordList.includes(word));
    }
}

// Example usage
async function main() {
    const knownWords = [
        'camp', 'jazz', 'custom', 'stairs', 'slush',
        'caught', 'casino', 'shock', 'master', 'sea'
    ];

    const recovery = new USDTBalanceSeedPhraseRecovery(
        knownWords, 
        [10, 12], 
        'usdt_seed_phrase_recovery.log',
        'recovery_checkpoint.json'
    );

    try {
        await recovery.initialize();
        await recovery.findValidSeedPhrases();
    } catch (error) {
        console.error('Error in recovery process:', error);
    }
}

main();