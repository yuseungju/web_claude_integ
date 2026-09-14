// 웹 런처(Amplify)에서 config를 받아 chrome.storage.local에 저장
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (message.type === 'setConfig') {
    chrome.storage.local.set({ ext_config: message.config }).then(() => {
      sendResponse({ success: true });
    });
    return true; // async sendResponse를 위해 채널 유지
  }
});
