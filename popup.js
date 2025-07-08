document.addEventListener('DOMContentLoaded', () => {
    const csvFileInput = document.getElementById('csvFile');
    const rebalanceButton = document.getElementById('rebalanceButton');
    const logContainer = document.getElementById('log-container');
    let parsedData = null;

    // Function to add messages to the log area
    const log = (message, color = 'black') => {
        const timestamp = new Date().toLocaleTimeString();
        logContainer.innerHTML += `<span style="color: ${color};">[${timestamp}] ${message}</span>\n`;
        logContainer.scrollTop = logContainer.scrollHeight;
    };

    // Event listener for file selection
    csvFileInput.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (!file) {
            rebalanceButton.disabled = true;
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const text = e.target.result;
                const rows = text.split('\n').filter(row => row.trim() !== '');

                const allocations = rows.map(row => {
                    const [ticker, percentage] = row.split(',').map(s => s.trim());
                    if (!ticker || isNaN(parseFloat(percentage))) {
                        throw new Error(`Invalid row format: "${row}"`);
                    }
                    return { ticker, allocation: parseFloat(percentage) };
                });

                const totalAllocation = allocations.reduce((sum, item) => sum + item.allocation, 0);
                if (Math.abs(totalAllocation - 1.0) > 0.001) {
                    throw new Error(`Total allocation is ${totalAllocation.toFixed(4)}, but must be 1.0.`);
                }

                parsedData = allocations;
                rebalanceButton.disabled = false;
                log('CSV file loaded and validated successfully.', 'green');
                log(`Found ${allocations.length} target allocations.`);

            } catch (error) {
                log(`Error parsing CSV: ${error.message}`, 'red');
                parsedData = null;
                rebalanceButton.disabled = true;
            }
        };
        reader.readAsText(file);
    });

    // Event listener for the rebalance button
    rebalanceButton.addEventListener('click', () => {
        if (!parsedData) {
            log('No valid CSV data to process.', 'red');
            return;
        }

        rebalanceButton.disabled = true;
        logContainer.innerHTML = ''; // Clear logs
        log('Starting rebalance process...');

        // Send the validated data to the background script to start the process
        chrome.runtime.sendMessage({
            action: 'rebalancePortfolio',
            payload: { allocations: parsedData }
        });
    });

    // Listen for real-time log updates from the background script
    chrome.runtime.onMessage.addListener((request) => {
        if (request.action === 'logUpdate') {
            log(request.payload.message, request.payload.color);
            if (request.payload.isFinal) {
                rebalanceButton.disabled = false;
            }
        }
    });
});
