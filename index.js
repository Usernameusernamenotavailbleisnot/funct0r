(async () => {
    const fetch = (await import('node-fetch')).default;
    const { HttpsProxyAgent } = await import('https-proxy-agent');
    const fs = require('fs').promises;
    const winston = require('winston');
    const { format } = winston;

    // Winston logger configuration with custom colors
    const customColors = {
        error: 'red',
        warn: 'yellow',
        info: 'green',
        debug: 'blue'
    };
    
    // Add custom colors to winston
    winston.addColors(customColors);
    
    const logger = winston.createLogger({
        level: 'info',
        format: format.combine(
            format.timestamp({
                format: () => {
                    const now = new Date();
                    return `${now.getDate().toString().padStart(2, '0')}/${(now.getMonth() + 1).toString().padStart(2, '0')}/${now.getFullYear()} - ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`
                }
            }),
            format.printf(({ level, message, timestamp, email }) => {
                return `[${timestamp}${email ? ` - ${email}` : ''}] ${message}`;
            })
        ),
        transports: [
            new winston.transports.Console({
                format: format.combine(
                    format.colorize({ all: true })
                )
            })
        ]
    });

    const headersTemplate = {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'User-Agent': "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"
    };

    // Load proxies from file
    async function loadProxies() {
        try {
            const data = await fs.readFile('proxy.txt', 'utf8');
            return data.split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#'));
        } catch (error) {
            logger.error({ message: "Error loading proxies: " + error.message });
            return [];
        }
    }

    // Retry utility function
    async function withRetry(fn, retries = 3, delay = 2000) {
        let lastError;
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;
                // If it's the last attempt, don't wait
                if (attempt < retries) {
                    const backoffDelay = delay * Math.pow(1.5, attempt - 1); // Exponential backoff
                    logger.warn({ message: `Attempt ${attempt} failed. Retrying in ${Math.round(backoffDelay/1000)}s... Error: ${error.message}` });
                    await new Promise(resolve => setTimeout(resolve, backoffDelay));
                }
            }
        }
        throw lastError; // If all retries failed, throw the last error
    }

    // Create fetch with proxy support and detailed error handling
// Modified proxyFetch function with selective retry
async function proxyFetch(url, method, payloadData = null, headers = headersTemplate, proxy = null) {
    const executeFetch = async () => {
        try {
            const options = {
                method,
                headers,
                body: payloadData ? JSON.stringify(payloadData) : null
            };

            // Add proxy agent if proxy is provided
            if (proxy) {
                const proxyUrl = `http://${proxy}`;
                options.agent = new HttpsProxyAgent(proxyUrl);
            }

            const response = await fetch(url, options);
            
            // Capture and expose HTTP status in the error
            if (!response.ok) {
                const error = new Error(`HTTP error! Status: ${response.status}`);
                error.status = response.status;
                
                // For check-in endpoint, don't retry on 400 status (already checked in)
                if (url.includes('/users/earn/') && error.status === 400) {
                    error.noRetry = true; // Mark this error to skip retries
                }
                
                throw error;
            }
            
            return await response.json();
        } catch (error) {
            // Preserve status code if it exists
            const enhancedError = new Error(`Request failed: ${error.message}`);
            if (error.status) enhancedError.status = error.status;
            if (error.noRetry) enhancedError.noRetry = true; // Pass noRetry flag if it exists
            throw enhancedError;
        }
    };
    
    // Modified withRetry function that checks for noRetry flag
    const withSelectiveRetry = async (fn, retries = 3, delay = 2000) => {
        let lastError;
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;
                
                // If error has noRetry flag, don't retry and throw immediately
                if (error.noRetry) {
                    throw error;
                }
                
                // If it's the last attempt, don't wait
                if (attempt < retries) {
                    const backoffDelay = delay * Math.pow(1.5, attempt - 1); // Exponential backoff
                    logger.warn({ message: `Attempt ${attempt} failed. Retrying in ${Math.round(backoffDelay/1000)}s... Error: ${error.message}` });
                    await new Promise(resolve => setTimeout(resolve, backoffDelay));
                }
            }
        }
        throw lastError; // If all retries failed, throw the last error
    };
    
    // Use selective retry mechanism for fetch operations
    return await withSelectiveRetry(executeFetch);
}

    // Load accounts from data.txt instead of JSON
    async function loadAccounts() {
        try {
            const data = await fs.readFile('data.txt', 'utf8');
            return data.split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#'))
                .map(line => {
                    const [email, password] = line.split(':');
                    return { email, password };
                });
        } catch (error) {
            logger.error({ message: "Error loading accounts: " + error.message });
            return [];
        }
    }

    async function loginAndCheckIn(email, password, proxy = null) {
        logger.info({ email, message: "Attempting login" });
        
        try {
            // Login with retry
            const signInPayload = { email, password };
            const signIn = await proxyFetch(
                "https://node.securitylabs.xyz/api/v1/auth/signin-user", 
                'POST', 
                signInPayload, 
                headersTemplate, 
                proxy
            );

            if (signIn && signIn.accessToken) {
                const headers = { ...headersTemplate, 'Authorization': `Bearer ${signIn.accessToken}` };
                logger.info({ email, message: "Login succeeded! Fetching user details..." });
                
                // Fetch user details with retry
                const user = await proxyFetch(
                    "https://node.securitylabs.xyz/api/v1/users", 
                    'GET', 
                    null, 
                    headers, 
                    proxy
                );
                
                const { id, dipTokenBalance } = user || {};
                if (id) {
                    logger.info({ email, message: `User id: ${id} | Current points: ${dipTokenBalance}` });
                    logger.info({ email, message: "Attempting daily check-in..." });
                    
                    try {
                        // Check-in with retry
                        const checkin = await proxyFetch(
                            `https://node.securitylabs.xyz/api/v1/users/earn/${id}`, 
                            'GET', 
                            null, 
                            headers, 
                            proxy
                        );
                        
                        if (checkin && checkin.tokensToAward) {
                            // Use ASCII color codes for more vibrant success message
                            const successMsg = `\x1b[38;5;46mCheck-in successful! Awarded points: ${checkin.tokensToAward}\x1b[0m`;
                            logger.info({ email, message: successMsg });
                        } else {
                            logger.warn({ email, message: 'Check-in not available yet.' });
                        }
                    } catch (checkinError) {
                        // Special handling for 400 error during check-in (already checked in)
                        if (checkinError.status === 400) {
                            const alreadyCheckedMsg = `\x1b[38;5;220mAlready checked in today\x1b[0m`;
                            logger.info({ email, message: alreadyCheckedMsg });
                        } else {
                            logger.error({ email, message: `Check-in failed: ${checkinError.message}` });
                        }
                    }
                }
            } else {
                logger.error({ email, message: "Login failed" });
            }
        } catch (error) {
            logger.error({ email, message: `Error during process: ${error.message}` });
        }
    }

    async function loadData() {
        // Wrapped data loading with retry logic
        return await withRetry(async () => {
            const accounts = await loadAccounts();
            const proxies = await loadProxies();
            return { accounts, proxies };
        }, 5, 3000); // 5 retries, starting with 3s delay
    }
    
    async function main() {
        try {
            // Load accounts and proxies with retry
            const { accounts, proxies } = await loadData();
            
            if (accounts.length === 0) {
                logger.error({ message: "No accounts found in data.txt" });
                return;
            }
    
            if (proxies.length === 0) {
                logger.warn({ message: "No proxies found in proxy.txt, will proceed without proxies" });
            } else {
                logger.info({ message: `Loaded ${proxies.length} proxies` });
            }
    
            logger.info({ message: `Loaded ${accounts.length} accounts` });
            
            while (true) {
                logger.info({ message: "\x1b[38;5;51m======== Starting daily check-in process ========\x1b[0m" });
                
                // Process all accounts with intelligent error handling
                for (let i = 0; i < accounts.length; i++) {
                    const { email, password } = accounts[i];
                    // Rotate through proxies if available
                    const proxy = proxies.length > 0 ? proxies[i % proxies.length] : null;
                    
                    if (email && password) {
                        try {
                            await loginAndCheckIn(email, password, proxy);
                        } catch (e) {
                            logger.error({ email, message: `Process failed: ${e.message}` });
                            
                            // Add additional retry logic for complete failures
                            if (i < accounts.length - 1) {
                                const retryDelay = 10000; // 10 seconds cooldown after a complete failure
                                logger.warn({ message: `Adding extra cooldown of ${retryDelay/1000}s after failure...` });
                                await new Promise(resolve => setTimeout(resolve, retryDelay));
                            }
                        }
                        
                        // Add a small delay between accounts to avoid rate limiting
                        if (i < accounts.length - 1) {
                            const delay = 3000 + Math.floor(Math.random() * 5000); // 3-8 seconds
                            logger.info({ message: `Waiting ${delay}ms before next account...` });
                            await new Promise(resolve => setTimeout(resolve, delay));
                        }
                    }
                }
                
                const nextRunTime = new Date();
                nextRunTime.setDate(nextRunTime.getDate() + 1);
                nextRunTime.setHours(0, Math.floor(Math.random() * 60), Math.floor(Math.random() * 60)); // Random time after midnight
                
                const timeUntilNextRun = nextRunTime.getTime() - Date.now();
                const hoursUntilNextRun = Math.floor(timeUntilNextRun / (1000 * 60 * 60));
                const minutesUntilNextRun = Math.floor((timeUntilNextRun % (1000 * 60 * 60)) / (1000 * 60));
                
                logger.info({ message: `\x1b[38;5;51m======== All accounts processed ========\x1b[0m` });
                logger.info({ message: `Next run scheduled at: ${nextRunTime.toLocaleString()} (in ${hoursUntilNextRun}h ${minutesUntilNextRun}m)` });
                
                await new Promise(resolve => setTimeout(resolve, timeUntilNextRun));
            }
        } catch (mainError) {
            logger.error({ message: `Critical error in main process: ${mainError.message}` });
            logger.info({ message: "Restarting main process in 60 seconds..." });
            
            // Add recovery for the entire process
            await new Promise(resolve => setTimeout(resolve, 60000));
            return main(); // Recursive restart of the main process
        }
    }
    
    main().catch(err => {
        logger.error({ message: `Main process error: ${err.message}` });
    });
})();
