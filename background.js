// A helper to pause execution for a specified time
const delay = ms => new Promise(res => setTimeout(res, ms));

// A helper to send log updates to the popup
const sendLog = (message, color = 'black', isFinal = false) => {
    chrome.runtime.sendMessage({
        action: 'logUpdate',
        payload: { message, color, isFinal }
    }).catch(() => console.log("Could not send log to popup, it might be closed."));
};

// --- Function to detect account mode, get account ID, and get dUUID ---
async function getAccountInfo() {
    const tabs = await chrome.tabs.query({ active: true, url: "*://app.trading212.com/*" });
    if (tabs.length === 0) throw new Error("No active Trading 212 tab found. Please navigate to the T212 web app.");

    const tabId = tabs[0].id;
    const tabUrl = tabs[0].url;

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
    const cookies = await chrome.cookies.getAll({ url: tabUrl });
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

    for (const cookie of cookies) {
        if (cookie.value) {
            try {
                const decodedValue = decodeURIComponent(cookie.value);
                const potentialUUID = decodedValue.replace(/"/g, '');
                if (uuidRegex.test(potentialUUID)) {
                    dUUID = potentialUUID;
                    break;
                }
            } catch (e) { /* Ignore malformed cookies */ }
        }
    }

    if (!dUUID) {
        dUUID = crypto.randomUUID();
        sendLog(`Could not find dUUID in cookies. Generated a new one for this session.`, 'orange');
    }

    return { mode, accountId, dUUID };
}

// A helper for making authenticated API calls
async function makeApiCall(url, method, { accountId, dUUID }, body = null) {
    const allCookies = await chrome.cookies.getAll({ domain: "trading212.com" });
    if (allCookies.length === 0) throw new Error("No Trading 212 cookies found. Please log in.");

    const cookieString = allCookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
    const headers = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Cookie': cookieString,
        'X-Trader-Client': `application=WC4,version=7.83.0,dUUID=${dUUID},accountId=${accountId}`
    };

    const options = { method, headers, body: body ? JSON.stringify(body) : null };
    const response = await fetch(url, options);
    const responseData = await response.json();
    if (!response.ok) throw new Error(responseData.message || responseData.developerMessage || `HTTP Error ${response.status}`);
    return responseData;
}

// Main function to handle the entire rebalancing logic
async function rebalancePortfolio(targetAllocations) {
    try {
        const accountInfo = await getAccountInfo();
        const baseUrl = `https://` + (accountInfo.mode === 'LIVE' ? 'live' : 'demo') + `.services.trading212.com`;
        const color = accountInfo.mode === 'LIVE' ? 'red' : 'blue';
        sendLog(`--- OPERATING IN ${accountInfo.mode} MODE (Account ID: ${accountInfo.accountId}) ---`, color);

        let summary = await makeApiCall(`${baseUrl}/rest/trading/invest/v2/accounts/summary`, 'POST', accountInfo, []);

        const pendingAdjustments = {};
        const positionDetails = summary.open.items.reduce((acc, pos) => {
            acc[pos.code] = pos;
            return acc;
        }, {});

        (summary.valueOrders.items || []).forEach(order => {
            pendingAdjustments[order.code] = (pendingAdjustments[order.code] || 0) + order.value;
        });
        (summary.orders.items || []).forEach(order => {
            if (order.quantity < 0) {
                const position = positionDetails[order.code];
                if (position && position.currentPrice) {
                    pendingAdjustments[order.code] = (pendingAdjustments[order.code] || 0) - (Math.abs(order.quantity) * position.currentPrice);
                }
            }
        });

        // --- SELL PHASE ---
        sendLog('Phase 1: Calculating sell orders...');
        const sellOrders = [];
        const allTickers = new Set([...Object.keys(positionDetails), ...targetAllocations.map(a => a.ticker), ...Object.keys(pendingAdjustments)]);

        allTickers.forEach(ticker => {
            const current = positionDetails[ticker];
            const effectiveValue = (current ? current.value : 0) + (pendingAdjustments[ticker] || 0);
            const targetValue = summary.cash.total * (targetAllocations.find(a => a.ticker === ticker)?.allocation || 0);
            const difference = targetValue - effectiveValue;

            if (difference < -1.00 && current) {
                sellOrders.push({ ticker, difference, currentQuantity: current.quantity, currentValue: current.value });
            }
        });

        if (sellOrders.length > 0) {
            sendLog(`Found ${sellOrders.length} sell orders to execute.`, 'orange');
            for (const order of sellOrders) {
                const valueToSell = Math.abs(order.difference);
                const remainingValue = order.currentValue - valueToSell;
                let calculatedQty;

                if (!targetAllocations.some(a => a.ticker === order.ticker && a.allocation > 0) || (remainingValue > 0 && remainingValue < 1.00)) {
                    calculatedQty = order.currentQuantity;
                    sendLog(`  - LIQUIDATING ${calculatedQty} of ${order.ticker}`);
                } else {
                    calculatedQty = (valueToSell / order.currentValue) * order.currentQuantity;
                }

                // First attempt with higher precision (4 decimals)
                let quantityToSell = parseFloat(calculatedQty.toFixed(4));

                if (quantityToSell > 0) {
                    let sellPayload = { instrumentCode: order.ticker, orderType: "MARKET", quantity: -quantityToSell, timeValidity: "GOOD_TILL_CANCEL" };
                    try {
                        sendLog(`  - Attempting to SELL ${quantityToSell} of ${order.ticker}`);
                        await makeApiCall(`${baseUrl}/rest/public/v2/equity/order`, 'POST', accountInfo, sellPayload);
                        sendLog(`    ✔ SUCCESS: Sell order for ${order.ticker} placed.`, 'green');
                    } catch (err) {
                        // *** FIX: If it's a precision error, retry with lower precision ***
                        if (err.message && err.message.includes('invalid quantity precision')) {
                            sendLog(`    ! Precision error hit. Retrying with lower precision...`, 'orange');
                            const lowerPrecisionQty = Math.trunc(calculatedQty * 100) / 100; // Truncate to 2 decimals

                            if (lowerPrecisionQty > 0) {
                                sellPayload.quantity = -lowerPrecisionQty;
                                sendLog(`    - Retrying with adjusted quantity of ${lowerPrecisionQty} for ${order.ticker}`);
                                try {
                                    await makeApiCall(`${baseUrl}/rest/public/v2/equity/order`, 'POST', accountInfo, sellPayload);
                                    sendLog(`    ✔ SUCCESS: Adjusted sell order placed.`, 'green');
                                } catch (retryErr) {
                                    sendLog(`    ✖ FAILED on retry for ${order.ticker}: ${retryErr.message}`, 'red');
                                }
                            } else {
                                sendLog(`    ✖ Adjusted quantity for ${order.ticker} is zero. Skipping.`, 'red');
                            }
                        } else {
                            // It was a different kind of error
                            sendLog(`    ✖ FAILED to sell ${order.ticker}: ${err.message}`, 'red');
                        }
                    }
                    await delay(1000);
                }
            }
        } else {
            sendLog('No sell orders needed.');
        }

        // --- BUY PHASE ---
        sendLog('Phase 2: Calculating buy orders...');
        summary = await makeApiCall(`${baseUrl}/rest/trading/invest/v2/accounts/summary`, 'POST', accountInfo, []);

        const updatedPositions = summary.open.items.reduce((acc, pos) => {
            acc[pos.code] = pos;
            return acc;
        }, {});
        const buyOrders = [];

        allTickers.forEach(ticker => {
            const current = updatedPositions[ticker];
            const effectiveValue = (current ? current.value : 0) + (pendingAdjustments[ticker] || 0);
            const targetValue = summary.cash.total * (targetAllocations.find(a => a.ticker === ticker)?.allocation || 0);
            const difference = targetValue - effectiveValue;

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
                        const match = err.message.match(/(\d+\.?\d*)/);
                        if (match && match[1]) {
                            const adjustedValue = parseFloat(match[1]);

                            // Check if adjusted value is sufficient before retrying
                            if (adjustedValue >= 1.00) {
                                buyPayload.value = adjustedValue;
                                sendLog(`    ! API limit hit. Retrying with adjusted value of €${adjustedValue.toFixed(2)}...`, 'orange');
                                try {
                                    await makeApiCall(`${baseUrl}/rest/v1/equity/value-order`, 'POST', accountInfo, buyPayload);
                                    sendLog(`    ✔ SUCCESS: Adjusted buy order placed.`, 'green');
                                } catch (retryErr) {
                                    sendLog(`    ✖ FAILED on retry for ${order.ticker}: ${retryErr.message}`, 'red');
                                }
                            } else {
                                sendLog(`    ✖ Adjusted buy value (€${adjustedValue.toFixed(2)}) is below minimum. Skipping retry for ${order.ticker}.`, 'red');
                            }
                        } else {
                            sendLog(`    ✖ FAILED to parse adjusted value from error: ${err.message}`, 'red');
                        }
                    } else {
                        sendLog(`    ✖ FAILED to buy ${order.ticker}: ${err.message}`, 'red');
                    }
                }
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

chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'rebalancePortfolio') {
        rebalancePortfolio(request.payload.allocations);
        return true;
    }
});
