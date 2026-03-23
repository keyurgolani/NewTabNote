/**
 * Offscreen document for New Tab Note
 * Handles API requests to bypass CORS restrictions using XMLHttpRequest
 */

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'OFFSCREEN_API_REQUEST') {
    handleApiRequest(request)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
});

/**
 * Handle an API request using XMLHttpRequest to bypass CORS.
 * @param {{url: string, options: {method?: string, body?: string}}} request - Request details
 * @returns {Promise<{ok: boolean, status: number, data: *}>} Response object
 */
async function handleApiRequest(request) {
  const { url, options } = request;
  
  console.debug('Offscreen: Making XHR request to', url);
  
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(options.method || 'GET', url, true);
    
    // Set content type header
    xhr.setRequestHeader('Content-Type', 'application/json');
    
    xhr.timeout = 60000; // 60 second timeout
    
    xhr.onload = function() {
      console.debug('Offscreen: XHR response status:', xhr.status);
      
      let data;
      try {
        data = JSON.parse(xhr.responseText);
      } catch (e) {
        data = xhr.responseText;
      }
      
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        data: data
      });
    };
    
    xhr.onerror = function() {
      console.error('Offscreen: XHR network error');
      reject(new Error('Network error'));
    };
    
    xhr.ontimeout = function() {
      console.error('Offscreen: XHR timeout');
      reject(new Error('Request timeout'));
    };
    
    xhr.send(options.body || null);
  });
}
