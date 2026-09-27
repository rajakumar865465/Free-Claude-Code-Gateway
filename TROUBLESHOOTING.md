# Troubleshooting: Test Connection Button Not Working

## Issue
Clicking "Test Connection" button does nothing - no response, no error.

## Debugging Steps

### Step 1: Restart Server
The JavaScript changes need to be loaded by restarting the server:

```bash
# Stop the server (Ctrl+C if running)

# Start the server
npm start
```

### Step 2: Clear Browser Cache
The browser might be using old cached JavaScript:

**Option A - Hard Refresh:**
- Windows/Linux: `Ctrl + Shift + R` or `Ctrl + F5`
- Mac: `Cmd + Shift + R`

**Option B - Clear Cache via DevTools:**
1. Press `F12` to open DevTools
2. Right-click on the browser refresh button
3. Select "Empty Cache and Hard Reload"

**Option C - Use Incognito/Private Window:**
- Open the admin page in a private/incognito window
- This ensures no cached files are used

### Step 3: Check Browser Console
1. Open DevTools: Press `F12`
2. Go to "Console" tab
3. Click "Test Connection" button
4. Look for:
   - ✅ `Test Connection button clicked` - Button works
   - ✅ `Provider type: databricks` - Type detected correctly
   - ❌ Any red error messages
   - ❌ Nothing appears → Event listener not attached

### Step 4: Check JavaScript File Loaded
In DevTools Console, type:
```javascript
typeof pfTestBtn
```
- If it shows `undefined` → JavaScript not loaded correctly
- If it shows `object` → Event listener might not be attached

Or check:
```javascript
document.querySelector('#pf-test-btn')
```
- Should show the button element

### Step 5: Verify File Changes
Check if the file on disk has the changes:
```bash
grep -n "console.log('Test Connection button clicked')" public/admin/dashboard.js
```
Should show line number where this appears.

### Step 6: Check for JavaScript Errors
In DevTools Console, look for any red error messages. Common issues:
- Syntax errors preventing script from loading
- Missing dependencies
- CORS errors
- Network errors loading the file

### Step 7: Verify Network Request
1. Open DevTools → Network tab
2. Refresh the page
3. Look for `dashboard.js` in the list
4. Check:
   - Status: Should be `200 OK`
   - Size: Should be ~200KB+ (not cached tiny size)
   - Click on it and go to "Response" tab
   - Search for "Test Connection button clicked" in the response
   - If found → File has the changes

### Step 8: Alternative - Manual Test
Open DevTools Console and paste this to manually test:

```javascript
const btn = document.querySelector('#pf-test-btn');
if (btn) {
  console.log('Button found!');
  btn.onclick = async function() {
    alert('Manual test clicked!');
  };
} else {
  console.log('Button NOT found!');
}
```

Then click the button. If alert shows → Button exists but event listener wasn't attached.

## Common Solutions

### Solution 1: Server Not Restarted
**Problem:** Old JavaScript still in memory
**Fix:** Stop server (Ctrl+C) and restart (`npm start`)

### Solution 2: Browser Cache
**Problem:** Browser serving old cached JavaScript
**Fix:** Hard refresh or use incognito mode

### Solution 3: JavaScript Error
**Problem:** Syntax error preventing script from loading
**Fix:** Check console for red errors, run `node -c public/admin/dashboard.js`

### Solution 4: Modal Not Open
**Problem:** Button doesn't exist because modal isn't open
**Fix:** Click "Add Provider" first, then click "Test Connection"

### Solution 5: Element ID Changed
**Problem:** Button ID doesn't match selector
**Fix:** In DevTools Elements tab, find the button and verify `id="pf-test-btn"`

### Solution 6: Script Loading Before DOM
**Problem:** JavaScript runs before button exists
**Fix:** Check if script has `DOMContentLoaded` wrapper (it should be at the bottom of the file)

## Quick Fix Commands

```bash
# Stop server
# Press Ctrl+C

# Clear any npm cache (rarely needed)
npm cache clean --force

# Rebuild
npm run build

# Start server
npm start
```

Then in browser:
1. Close all tabs with the admin page
2. Open new incognito/private window  
3. Navigate to `http://localhost:8787/admin`
4. Click "Add Provider"
5. Select "Databricks"
6. Open Console (F12)
7. Click "Test Connection"
8. Check console for logs

## Expected Behavior After Fix

When you click "Test Connection":
1. Console shows: `Test Connection button clicked`
2. Console shows: `Provider type: databricks`
3. If API key is empty: Toast shows "Enter an API Key to test the connection."
4. If model ID is empty: Toast shows "Enter a Model ID to test the connection"
5. If both filled: Shows "Fetching models..." then result (success or error)

## Still Not Working?

If none of the above works, check:

1. **Are you editing the right file?**
   - File should be: `public/admin/dashboard.js`
   - NOT: `src/admin/dashboard.js` (doesn't exist)
   - NOT: `dist/admin/dashboard.js` (compiled output)

2. **Is the server serving static files correctly?**
   ```bash
   curl http://localhost:8787/admin/dashboard.js | grep "Test Connection button clicked"
   ```
   Should show the line if changes are there.

3. **Check server logs**
   - Look for any errors when serving static files
   - Make sure server started successfully

4. **Port conflict?**
   - Make sure you're accessing the right port (8787)
   - Check if another instance is running: `netstat -ano | findstr :8787`

## Contact Developer

If issue persists, provide:
- Console errors (screenshot)
- Network tab showing dashboard.js request
- Server startup logs
- Browser and version
- Operating system
