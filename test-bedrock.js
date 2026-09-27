// Test AWS Bedrock with the fixed endpoint
// Node.js 18+ has fetch built-in globally

async function testBedrock() {
  console.log('🧪 Testing AWS Bedrock Provider...\n');
  
  // Test 1: Get provider status via admin API
  console.log('Test 1: Checking provider configuration...');
  try {
    const providersRes = await fetch('http://localhost:8787/admin/api/providers');
    const providersData = await providersRes.json();
    
    const bedrockProvider = providersData.providers.find(p => p.type === 'aws_bedrock');
    if (bedrockProvider) {
      console.log('✅ Bedrock provider found:');
      console.log(`   - Name: ${bedrockProvider.name}`);
      console.log(`   - Region: ${bedrockProvider.awsRegion}`);
      console.log(`   - Model: ${bedrockProvider.defaultModel}`);
      console.log(`   - Active: ${providersData.activeId === bedrockProvider.id}`);
    } else {
      console.log('❌ No Bedrock provider found');
      return;
    }
  } catch (error) {
    console.log('❌ Failed to fetch providers:', error.message);
    return;
  }
  
  console.log('\n---\n');
  
  // Test 2: Send a test chat completion request
  console.log('Test 2: Sending chat completion request...');
  try {
    const response = await fetch('http://localhost:8787/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'zai.glm-5',
        messages: [
          { role: 'user', content: 'Say "Hello from AWS Bedrock!"' }
        ],
        max_tokens: 50,
        stream: false
      })
    });
    
    const data = await response.json();
    
    if (response.ok) {
      console.log('✅ Request successful!');
      console.log(`   - Status: ${response.status}`);
      if (data.choices && data.choices[0]) {
        console.log(`   - Response: "${data.choices[0].message.content}"`);
      }
      if (data.usage) {
        console.log(`   - Tokens: ${data.usage.prompt_tokens} in, ${data.usage.completion_tokens} out`);
      }
      console.log('\n🎉 AWS Bedrock is working with the bedrock-mantle endpoint!');
    } else {
      console.log('❌ Request failed:');
      console.log(`   - Status: ${response.status}`);
      console.log(`   - Error: ${JSON.stringify(data, null, 2)}`);
    }
  } catch (error) {
    console.log('❌ Request error:', error.message);
  }
  
  console.log('\n---\n');
  
  // Test 3: Test streaming
  console.log('Test 3: Testing streaming...');
  try {
    const response = await fetch('http://localhost:8787/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'zai.glm-5',
        messages: [
          { role: 'user', content: 'Count from 1 to 5' }
        ],
        max_tokens: 50,
        stream: true
      })
    });
    
    if (response.ok && response.body) {
      console.log('✅ Streaming started');
      console.log('   - Receiving chunks...\n');
      
      let fullText = '';
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value);
        const lines = chunk.split('\n').filter(line => line.trim().startsWith('data:'));
        
        for (const line of lines) {
          const data = line.replace('data:', '').trim();
          if (data === '[DONE]') continue;
          if (!data) continue;
          
          try {
            const parsed = JSON.parse(data);
            if (parsed.choices && parsed.choices[0]?.delta?.content) {
              const content = parsed.choices[0].delta.content;
              fullText += content;
              process.stdout.write(content);
            }
          } catch (e) {
            // Skip non-JSON lines
          }
        }
      }
      
      console.log('\n\n✅ Streaming completed');
      console.log(`   - Received: "${fullText}"`);
      console.log('\n🎉 Streaming is working!');
    } else {
      console.log('❌ Streaming failed');
      console.log(`   - Status: ${response.status}`);
    }
  } catch (error) {
    console.log('❌ Streaming error:', error.message);
  }
}

// Run the tests
testBedrock().then(() => {
  console.log('\n✨ All tests completed!\n');
}).catch(error => {
  console.error('Test error:', error);
  process.exit(1);
});
