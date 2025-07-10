t212PortfolioSync - a chrome extension that syncs your (live) portfolio to allocations in a CSV file

image here

* Easy to use - just import the CSV file and click the "Rebalance" button
* Easy to install
* Works in the background
* Both BUY and SELL orders are used to match the allocations as precisely as possible
* Tested on large amounts of positions
* Useful for traders willing to sync their portfolios to predetermined allocations, say copying a hedge fund's latest known open positions
* No need to enter T212 credentials - it uses authentication already present in your browser
* Resilient to changes in T212's UI as it uses reverse-engineered T212 APIs
* Code is made to be simple on purpose so anyone can modify it to their needs

INSTALLATION
* Click "Code" -> "Download ZIP"
* Extract the ZIP file
* Go to chrome://extensions/
* Enable "Developer mode"
* Click "Load unpacked" and select the extracted folder
* On app.trading212.com and click the extension icon

TODO
* Critical - Unknown interactions could be possible if the user has pies - extensive testing and mitigations needed
* Important - A comprehensive retry mechanism
* Important - Implement fetching open orders to use them in adjustment calculations
* Mild - Checking whether it is possible to modify positions before placing orders and showing it to the user
* Mild - Python interop extension to allow for a true algotrading experience
* Mild - Allow the user to enter non-T212 stock names, where the script, using T212's public API, would determine the names.
* Mild - A better notification tray where the user could see the failed positions at a glance


