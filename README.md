![T212PortfolioSync Logo](/images/icon128.png)
# t212PortfolioSync

A Chrome extension that syncs your demo/live Trading 212 portfolio to allocations defined in a CSV file.

![T212 Portfolio Sync Demo](/docs/media/T212Sync.gif)

## ✨ Features

*   **Easy to use**: Just import the CSV file and click the "Rebalance" button.
*   **Simple installation**: Get up and running in a few clicks.
*   **Works in the background**: The extension handles all operations without interrupting your workflow.
*   **Precise allocation matching**: Uses both BUY and SELL orders to match your target allocations as closely as possible.
*   **Safe**: No unwanted interactions with existing equity allocations in pies.
*   **Tested**: The logic has been tested on accounts with a large number of positions.
*   **Versatile**: Useful for traders who want to sync their portfolios to predetermined allocations, such as copying a hedge fund's latest known open positions.
*   **Secure**: No need to enter T212 credentials. The extension uses the authentication already present in your browser.
*   **Resilient**: Less prone to breaking from website updates, as it uses reverse-engineered T212 APIs instead of UI scraping.
*   **Customizable**: The code is intentionally kept simple so anyone can modify it to their needs.
*   **Free**: No ads, no tracking, no data collection.

## 🚀 Installation

1.  Click the **Code** button on the GitHub repository page, then select **Download ZIP**.
2.  Extract the downloaded ZIP file to a location of your choice.
3.  Open Google Chrome and navigate to `chrome://extensions/`.
4.  Enable **Developer mode** using the toggle switch in the top-right corner.
5.  Click the **Load unpacked** button and select the extracted folder.
6.  Navigate to `app.trading212.com` and click the extension icon in your toolbar to begin.

## 📝 Future Plans

-   [ ] **Important:** Implement a more comprehensive retry mechanism for failed API requests.
-   [ ] **Important:** Implement using non-value sell orders to include them in rebalancing calculations.
-   [ ] **Mild:** Add a check to see if positions can be modified before placing orders and show the status to the user.
-   [ ] **Mild:** Should add an option to pick a stock into which the money that was impossible to invest into the allocations due to minimum order quantity, would be automatically invested into.
-   [ ] **Mild:** Develop a Python interop extension to allow for a true algorithmic trading experience.
-   [ ] **Mild:** Allow the user to enter common stock tickers (e.g., AAPL, MSFT), which the script would then resolve to the correct T212 instrument code using public APIs.
-   [ ] **Mild:** Create a better notification tray where the user can see any failed orders at a glance.

## ⚠️ Disclaimer

*   **I am not responsible for any losses incurred while using this script. Use at your own risk.**
