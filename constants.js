module.exports = {
    LOGIN_SELECTORS: {
      email: 'input[name="email"]',
      submit: 'button[type="submit"]',
      passwordOption: 'button[data-testid="login-magic-link"]',
      passwordInput: 'input[name="password"]',
      passwordSubmit: 'button[type="submit"]'
    },
    
    INVITES_SELECTOR: {
      container: 'ul.md-list[data-v-]',
      items: 'li.vdl-invite-list-item',
      title: '.item-title',
      link: 'a',
      acceptButton: 'button:has-text("Accept Invite")',
      scriptContainer: '#custom_sample_info',
      scriptText: '.content.clickable span'
    }
  };