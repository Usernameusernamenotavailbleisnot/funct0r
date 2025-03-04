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

    // Create fetch with proxy support
    async function proxyFetch(url, method, payloadData = null, headers = headersTemplate, proxy = null) {
        try {
            const options = {
                method,
                headers,
                body: payloadData ? JSON.stringify(payloadData) : null
            };

            // Add proxy agent if proxy is provided
            if (proxy) {
                const [auth, hostPort] = proxy.split('@');
                const proxyUrl = `http://${proxy}`;
                options.agent = new HttpsProxyAgent(proxyUrl);
            }

            const response = await fetch(url, options);
            if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
            return await response.json();
        } catch (error) {
            throw new Error(`Request failed: ${error.message}`);
        }
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
                        logger.error({ email, message: `Check-in failed: ${checkinError.message}` });
                    }
                }
            } else {
                logger.error({ email, message: "Login failed" });
            }
        } catch (error) {
            logger.error({ email, message: `Error during process: ${error.message}` });
        }
    }

    async function main() {
        // Load accounts and proxies
        const accounts = await loadAccounts();
        const proxies = await loadProxies();
        
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
            logger.info({ message: "Starting daily check-in process for all accounts..." });
            
            for (let i = 0; i < accounts.length; i++) {
                const { email, password } = accounts[i];
                // Rotate through proxies if available
                const proxy = proxies.length > 0 ? proxies[i % proxies.length] : null;
                
                if (email && password) {
                    try {
                        await loginAndCheckIn(email, password, proxy);
                    } catch (e) {
                        logger.error({ email, message: `Process failed: ${e.message}` });
                    }
                    
                    // Add a small delay between accounts to avoid rate limiting
                    if (i < accounts.length - 1) {
                        const delay = 3000 + Math.floor(Math.random() * 5000); // 3-8 seconds
                        logger.info({ message: `Waiting ${delay}ms before next account...` });
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                }
            }
            
            logger.info({ message: "All accounts processed. Waiting 24 hours for the next check-in..." });
            await new Promise(resolve => setTimeout(resolve, 24 * 60 * 60 * 1000));  // 24 hours cooldown
        }
    }
    
    main().catch(err => {
        logger.error({ message: `Main process error: ${err.message}` });
    });
})();
