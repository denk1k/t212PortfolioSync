// A helper to pause execution for a specified time
const delay = ms => new Promise(res => setTimeout(res, ms));

// A helper to send log updates to the popup
const sendLog = (message, color = 'black', isFinal = false) => {
    chrome.runtime.sendMessage({
        action: 'logUpdate',
        payload: { message, color, isFinal }
    }).catch(() => console.log("Could not send log to popup, it might be closed."));
};

async function getAccountInfo() {
    const tabs = await chrome.tabs.query({ active: true, url: "*://app.trading212.com/*" });
    if (tabs.length === 0) {
        throw new Error("No active Trading 212 tab found. Please navigate to the T212 web app.");
    }
    const tabId = tabs[0].id;
    const storageResults = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: () => ({
            mode: localStorage.getItem('lastLogInSubSystem'),
            accountId: localStorage.getItem('lastLogInAccountId')
        }),
    });

    const data = storageResults[0].result;
    if (!data || !data.mode || !data.accountId) throw new Error("Could not determine account mode or ID from localStorage.");

    const mode = data.mode.replace(/"/g, '').toUpperCase();
    const accountId = data.accountId.replace(/"/g, '');
    if ((mode !== 'LIVE' && mode !== 'DEMO') || !accountId) throw new Error(`Invalid account info from storage: Mode='${mode}', AccountID='${accountId}'`);

    let dUUID = null;
    const cookies = await chrome.cookies.getAll({ domain: "app.trading212.com" });
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

    for (const cookie of cookies) {
        if (cookie.value) {
            try {
                const decodedValue = decodeURIComponent(cookie.value);
                const potentialUUID = decodedValue.replace(/"/g, '');
                if (uuidRegex.test(potentialUUID)) {
                    dUUID = potentialUUID;
                    sendLog(`Found dUUID in cookie '${cookie.name}'.`, 'gray');
                    break;
                }
            } catch (e) {
                // Ignore cookies with malformed URI encoding.
            }
        }
    }

    if (!dUUID) {
        dUUID = crypto.randomUUID();
        sendLog(`Could not find dUUID in cookies. Generated a new one for this session.`, 'orange');
    }

    return { mode, accountId, dUUID };
}

async function makeApiCall(url, method, { accountId, dUUID }, body = null) {
    const cookies = await chrome.cookies.getAll({ domain: "trading212.com" });
    if (cookies.length === 0) throw new Error("No Trading 212 cookies found. Please log in.");

    const cookieString = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');

    const headers = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Cookie': cookieString,
        'X-Trader-Client': `application=WC4,version=7.83.0,dUUID=${dUUID},accountId=${accountId}`
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
        // --- Step 1: Determine Environment and Account ID ---
        const accountInfo = await getAccountInfo(); // Contains mode, accountId, and dUUID
        const baseUrl = `https://` + (accountInfo.mode === 'LIVE' ? 'live' : 'demo') + `.services.trading212.com`;

        const color = accountInfo.mode === 'LIVE' ? 'red' : 'blue';
        sendLog(`--- OPERATING IN ${accountInfo.mode} MODE (Account ID: ${accountInfo.accountId}) ---`, color);

        sendLog('Fetching initial account summary...');
        let summary = await makeApiCall(`${baseUrl}/rest/trading/invest/v2/accounts/summary`, 'POST', accountInfo, []);

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

            if (difference < -1.00) {
                sellOrders.push({ ticker, difference, currentQuantity: current.quantity, currentValue: current.value });
            }
        });

        if (sellOrders.length > 0) {
            sendLog(`Found ${sellOrders.length} sell orders to execute.`, 'orange');
            for (const order of sellOrders) {
                let quantityToSell;
                const isLiquidatingCompletely = !targetAllocations.some(a => a.ticker === order.ticker && a.allocation > 0);
                const valueToSell = Math.abs(order.difference);
                const remainingValue = order.currentValue - valueToSell;

                if (isLiquidatingCompletely || (remainingValue > 0 && remainingValue < 1.00)) {
                    quantityToSell = order.currentQuantity;
                    if (!isLiquidatingCompletely) {
                        sendLog(`  ! Remaining value for ${order.ticker} would be too small (€${remainingValue.toFixed(2)}). Liquidating instead.`);
                    }
                    sendLog(`  - LIQUIDATING ${quantityToSell} of ${order.ticker}`);
                } else {
                    const calculatedQty = (valueToSell / order.currentValue) * order.currentQuantity;
                    quantityToSell = parseFloat(calculatedQty.toFixed(4));
                    sendLog(`  - SELLING ${quantityToSell} of ${order.ticker} (value ~€${valueToSell.toFixed(2)})`);
                }

                const sellPayload = { instrumentCode: order.ticker, orderType: "MARKET", quantity: -quantityToSell, timeValidity: "GOOD_TILL_CANCEL" };

                try {
                    await makeApiCall(`${baseUrl}/rest/public/v2/equity/order`, 'POST', accountInfo, sellPayload);
                    sendLog(`    ✔ SUCCESS: Sell order for ${order.ticker} placed.`, 'green');
                } catch (err) {
                    sendLog(`    ✖ FAILED to sell ${order.ticker}: ${err.message}`, 'red');
                }

                sendLog('    ...waiting 1 second...');
                await delay(1000);
            }
        } else {
            sendLog('No sell orders needed.');
        }

        // --- BUY PHASE ---
        sendLog('Phase 2: Calculating and executing buy orders...');
        sendLog('Re-fetching account state to ensure accurate buy calculations...');
        summary = await makeApiCall(`${baseUrl}/rest/trading/invest/v2/accounts/summary`, 'POST', accountInfo, []);

        let updatedPositions = summary.open.items.reduce((acc, pos) => {
            acc[pos.code] = { value: pos.value, quantity: pos.quantity };
            return acc;
        }, {});

        let totalPortfolioValue = summary.cash.total;
        sendLog(`Account total value: €${totalPortfolioValue.toFixed(2)}`, 'blue');

        const buyOrders = [];
        const finalTickers = new Set([...Object.keys(updatedPositions), ...targetAllocations.map(a => a.ticker)]);

        finalTickers.forEach(ticker => {
            const target = targetAllocations.find(a => a.ticker === ticker);
            const current = updatedPositions[ticker];
            const targetValue = totalPortfolioValue * (target ? target.allocation : 0);
            const currentValue = current ? current.value : 0;
            const difference = targetValue - currentValue;

            if (difference > 1.00) {
                buyOrders.push({ ticker, valueToBuy: difference });
            }
        });

        if (buyOrders.length > 0) {
            sendLog(`Found ${buyOrders.length} buy orders to execute.`, 'orange');
            for (const order of buyOrders) {
                const valueToBuy = parseFloat(order.valueToBuy.toFixed(2));
                let buyPayload = { currency: "EUR", instrumentCode: order.ticker, value: valueToBuy, orderType: "MARKET", timeValidity: "GOOD_TILL_CANCEL" };

                sendLog(`  - Attempting to BUY €${valueToBuy.toFixed(2)} of ${order.ticker}`);

                try {
                    await makeApiCall(`${baseUrl}/rest/v1/equity/value-order`, 'POST', accountInfo, buyPayload);
                    sendLog(`    ✔ SUCCESS: Buy order for ${order.ticker} placed.`, 'green');
                } catch (err) {
                    if (err.message && err.message.includes('must buy at most')) {
                        sendLog(`    ! API limit hit. Retrying with suggested value...`, 'orange');
                        const match = err.message.match(/(\d+\.\d+)/);
                        if (match && match[1]) {
                            const adjustedValue = parseFloat(match[1]);
                            buyPayload.value = adjustedValue;
                            sendLog(`    - ADJUSTED BUY of €${adjustedValue.toFixed(2)} for ${order.ticker}`);
                            try {
                                await makeApiCall(`${baseUrl}/rest/v1/equity/value-order`, 'POST', accountInfo, buyPayload);
                                sendLog(`    ✔ SUCCESS: Adjusted buy order for ${order.ticker} placed.`, 'green');
                            } catch (retryErr) {
                                sendLog(`    ✖ FAILED on retry for ${order.ticker}: ${retryErr.message}`, 'red');
                            }
                        } else {
                            sendLog(`    ✖ FAILED to parse adjusted value from error: ${err.message}`, 'red');
                        }
                    } else {
                        sendLog(`    ✖ FAILED to buy ${order.ticker}: ${err.message}`, 'red');
                    }
                }

                sendLog('    ...waiting 1 second...');
                await delay(1000);
            }
        } else {
            sendLog('No buy orders needed.');
        }

        sendLog('Rebalancing process complete!', 'blue', true);

    } catch (error) {
        sendLog(`CRITICAL ERROR: ${error.message}`, 'red', true);
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'rebalancePortfolio') {
        rebalancePortfolio(request.payload.allocations);
        return true;
    }
});
