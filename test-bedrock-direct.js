// Direct test of AWS Bedrock endpoint without proxy
const https = require('https');

const region = 'us-east-1';
const model = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
const apiKey = 'YOUR_BEDROCK_API_KEY_HERE'; // Replace with your actual key

// Test 1: Check DNS resolution
console.log('🔍 Test 1: DNS Resolution');
const dns = require('dns');
const hostname = `bedrock-mantle.${region}.amazonaws.com`;
console.log(`Resolving: ${hostname}`);

dns.resolve4(hostname, (err, addresses) => {
  if (err) {
    console.log(`❌ DNS resolution failed: ${err.message}`);
    console.log(`   This means the bedrock-mantle endpoint doesn't exist or isn't reachable`);
    console.log(`\n💡 Solution: AWS Bedrock might not support bedrock-mantle endpoint yet`);
    console.log(`   Try using bedrock-runtime instead, or check if your region supports it\n`);
  } else {
    console.log(`✅ DNS resolved to: ${addresses.join(', ')}\n`);
    
    // Test 2: Try HTTP request
    console.log('🔍 Test 2: HTTP Request to /v1/models');
    const options = {
      hostname: hostname,
      port: 443,
      path: '/v1/models',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    };
    
    const req = https.request(options, (res) => {
      console.log(`Status: ${res.statusCode}`);
      console.log(`Headers:`, JSON.stringify(res.headers, null, 2));
      
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        console.log(`\nResponse: ${data.substring(0, 500)}`);
        if (res.statusCode === 200) {
          console.log('\n✅ bedrock-mantle endpoint is working!');
        } else {
          console.log('\n❌ bedrock-mantle endpoint returned error');
        }
      });
    });
    
    req.on('error', (e) => {
      console.log(`❌ Request error: ${e.message}`);
    });
    
    req.setTimeout(5000, () => {
      console.log('❌ Request timeout');
      req.destroy();
    });
    
    req.end();
  }
});

// Alternative test with bedrock-runtime
console.log('\n---\n');
console.log('🔍 Test 3: Testing bedrock-runtime (alternative)');
const hostnameAlt = `bedrock-runtime.${region}.amazonaws.com`;
console.log(`Resolving: ${hostnameAlt}`);

dns.resolve4(hostnameAlt, (err, addresses) => {
  if (err) {
    console.log(`❌ DNS resolution failed: ${err.message}\n`);
  } else {
    console.log(`✅ DNS resolved to: ${addresses.join(', ')}`);
    console.log(`   bedrock-runtime endpoint exists!\n`);
  }
});
