const { ethers } = require('ethers');
const fs = require('fs').promises;
const path = require('path');


async function diagnoseRecovery() {
    const knownWords = [
        'camp', 'jazz', 'custom', 'stair', 'slush', 
        'caught', 'casino', 'shock', 'master', 'sea'
    ];

    console.log("Checking known words:");
    const wordListPromise = fs.readFile(path.join(__dirname, 'english.txt'), 'utf8')
        .then(content => content.trim().split('\n'));
    
    const wordList = await wordListPromise;
    
    // Check if all known words are in the BIP39 word list
    const invalidWords = knownWords.filter(word => !wordList.includes(word));
    if (invalidWords.length > 0) {
        console.log("Invalid words found:", invalidWords);
        return;
    }

    // Try a few manual tests
    const recovery = new ExhaustiveSeedPhraseRecovery(
        knownWords, 
        [10, 12], 
        'seed_phrase_diagnostic.log'
    );
    
    await recovery.initialize();

    // Add some manual validation
    const testWords = [...knownWords];
    const wordListLength = recovery.wordList.length;

    // Try a few specific words in the missing positions
    for (let i = 0; i < wordListLength; i++) {
        for (let j = 0; j < wordListLength; j++) {
            testWords[9] = recovery.wordList[i];   // Position 10
            testWords[11] = recovery.wordList[j];  // Position 12

            const isValid = await recovery.validateSeedPhrase(testWords);
            if (isValid) {
                console.log("Found a valid combination!");
                console.log("Words:", testWords);
                return;
            }
        }
    }

    console.log("No valid combinations found after targeted search.");
}

diagnoseRecovery();