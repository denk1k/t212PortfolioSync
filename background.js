// A helper to pause execution for a specified time
const delay = ms => new Promise(res => setTimeout(res, ms));

// A helper to send log updates to the popup
const sendLog = (message, color = 'black', isFinal = false) => {
    chrome.runtime.sendMessage({
        action: 'logUpdate',
        payload: { message, color, isFinal }
    }).catch(() => console.log("Could not send log to popup, it might be closed."));
};

// A helper for making authenticated API calls to Trading 212
async function makeApiCall(url, method, body = null) {
    const cookies = await chrome.cookies.getAll({ domain: "trading212.com" });
    if (cookies.length === 0) {
        throw new Error("No Trading 212 cookies found. Please log in.");
    }
    const cookieString = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');

    // NOTE: This accountId is hardcoded from your cURL example.
    const accountId = "33029497";

    const headers = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Cookie': cookieString,
        'X-Trader-Client': `application=WC4,version=7.83.0,dUUID=4e354fd1-83c7-4edc-a49d-620c3eaa9cd9,accountId=${accountId}`
    };

    const options = { method, headers };
    if (body) {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    const responseData = await response.json();

    if (!response.ok) {
        const errorMessage = responseData.message || responseData.developerMessage || `HTTP Error ${response.status}`;
        throw new Error(errorMessage);
    }

    return responseData;
}

// Main function to handle the entire rebalancing logic
async function rebalancePortfolio(targetAllocations) {
    try {
        // Step 1: Fetch initial account summary
        sendLog('Fetching initial account summary...');
        let summary = await makeApiCall('https://demo.services.trading212.com/rest/trading/invest/v2/accounts/summary', 'POST', []);

        // --- SELL PHASE ---
        sendLog('Phase 1: Calculating and executing sell orders...');
        let initialPositions = summary.open.items.reduce((acc, pos) => {
            acc[pos.code] = { value: pos.value, quantity: pos.quantity };
            return acc;
        }, {});
        let initialEquity = summary.cash.total;

        const sellOrders = [];
        const allTickers = new Set([...Object.keys(initialPositions), ...targetAllocations.map(a => a.ticker)]);

        allTickers.forEach(ticker => {
            const target = targetAllocations.find(a => a.ticker === ticker);
            const current = initialPositions[ticker];
            const targetValue = initialEquity * (target ? target.allocation : 0);
            const currentValue = current ? current.value : 0;
            const difference = targetValue - currentValue;

            if (difference < -1.00) { // Only consider sells (negative difference)
                sellOrders.push({ ticker, difference, currentQuantity: current.quantity, currentValue: current.value });
            }
        });

        if (sellOrders.length > 0) {
            sendLog(`Found ${sellOrders.length} sell orders to execute.`, 'orange');
            for (const order of sellOrders) {
                let quantityToSell;
                const isLiquidating = !targetAllocations.some(a => a.ticker === order.ticker && a.allocation > 0);

                if (isLiquidating) {
                    quantityToSell = order.currentQuantity; // Sell entire position
                    sendLog(`  - LIQUIDATING ${quantityToSell.toFixed(6)} of ${order.ticker}`);
                } else {
                    // Calculate quantity to sell based on the value difference
                    quantityToSell = (Math.abs(order.difference) / order.currentValue) * order.currentQuantity;
                    sendLog(`  - SELLING ${quantityToSell.toFixed(6)} of ${order.ticker} (value ~€${Math.abs(order.difference).toFixed(2)})`);
                }

                const sellPayload = { instrumentCode: order.ticker, orderType: "MARKET", quantity: -quantityToSell, timeValidity: "GOOD_TILL_CANCEL" };

                try {
                    await makeApiCall('https://demo.services.trading212.com/rest/public/v2/equity/order', 'POST', sellPayload);
                    sendLog(`    ✔ SUCCESS: Sell order for ${order.ticker} placed.`, 'green');
                } catch (err) {
                    sendLog(`    ✖ FAILED to sell ${order.ticker}: ${err.message}`, 'red');
                }

                sendLog('    ...waiting 1 second...');
                await delay(1000); // Wait 1 second after each request
            }
        } else {
            sendLog('No sell orders needed.');
        }

        // --- BUY PHASE ---
        sendLog('Phase 2: Calculating and executing buy orders...');
        sendLog('Re-fetching account state to ensure accurate buy calculations...');
        summary = await makeApiCall('https://demo.services.trading212.com/rest/trading/invest/v2/accounts/summary', 'POST', []);

        let updatedPositions = summary.open.items.reduce((acc, pos) => {
            acc[pos.code] = { value: pos.value, quantity: pos.quantity };
            return acc;
        }, {});
        let updatedEquity = summary.cash.total;
        sendLog(`New account equity is €${updatedEquity.toFixed(2)}`, 'blue');

        const buyOrders = [];
        const finalTickers = new Set([...Object.keys(updatedPositions), ...targetAllocations.map(a => a.ticker)]);

        finalTickers.forEach(ticker => {
            const target = targetAllocations.find(a => a.ticker === ticker);
            const current = updatedPositions[ticker];
            const targetValue = updatedEquity * (target ? target.allocation : 0);
            const currentValue = current ? current.value : 0;
            const difference = targetValue - currentValue;

            if (difference > 1.00) { // Only consider buys (positive difference)
                buyOrders.push({ ticker, valueToBuy: difference });
            }
        });

        if (buyOrders.length > 0) {
            sendLog(`Found ${buyOrders.length} buy orders to execute.`, 'orange');
            for (const order of buyOrders) {
                const buyPayload = { currency: "EUR", instrumentCode: order.ticker, value: order.valueToBuy, orderType: "MARKET", timeValidity: "GOOD_TILL_CANCEL" };
                sendLog(`  - BUYING €${order.valueToBuy.toFixed(2)} of ${order.ticker}`);

                try {
                    await makeApiCall('https://demo.services.trading212.com/rest/v1/equity/value-order', 'POST', buyPayload);
                    sendLog(`    ✔ SUCCESS: Buy order for ${order.ticker} placed.`, 'green');
                } catch (err) {
                    sendLog(`    ✖ FAILED to buy ${order.ticker}: ${err.message}`, 'red');
                }

                sendLog('    ...waiting 1 second...');
                await delay(1000); // Wait 1 second after each request
            }
        } else {
            sendLog('No buy orders needed.');
        }

        sendLog('Rebalancing process complete!', 'blue', true);

    } catch (error) {
        sendLog(`CRITICAL ERROR: ${error.message}`, 'red', true);
    }
}

// Listen for the rebalance command from the popup
chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'rebalancePortfolio') {
        rebalancePortfolio(request.payload.allocations);
        return true; // Indicates an asynchronous response
    }
});
