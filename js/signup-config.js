/*
 * SIGNUP SETTINGS — the only file you edit to change signup prices, links, or terms.
 *
 * Promo codes are NOT set here. They live in Stripe (Dashboard → Product catalog →
 * Coupons → Promotion codes); the signup Worker checks every code with Stripe.
 * See _docs/ESIGN-SETUP.md. Prices here must match _worker/wrangler.toml and index.html.
 */
(function (root, factory) {
  var config = factory();
  if (typeof module === 'object' && module.exports) module.exports = config;
  else root.SIGNUP_CONFIG = config;
})(this, function () {
  return {
    // Bump this whenever agreement.html wording changes (also AGREEMENT_VERSION in _worker/wrangler.toml),
    // then run: npm run agreement-hash && npm run agreement-pdf (refreezes the Worker's copy and the PDF).
    agreementVersion: '2026-11-20.1',

    // SHA-256 of the agreement text in agreement.html (between its two markers). A unit test fails
    // if the text changes without updating this, so every signup record points to exact wording.
    // Changed the agreement? Bump agreementVersion, then run: npm run agreement-hash
    agreementHash: '8ef358a68d1f558d6515d370022467da350f844da3ca816e6a047a9b1c4cf614',

    // Satisfaction guarantee length shown in the agreement (days after launch).
    guaranteeDays: 60,

    // CONFIRM WITH YOUR ATTORNEY before going live.
    governingLawState: 'Minnesota',

    // Public pricing — must match index.html and your Stripe products.
    build: { name: 'Website + SEO Build', price: 199, maxFacilities: 7 },
    plans: [
      { id: 'none', name: 'No monthly service', price: 0 },
      { id: 'maintain', name: 'Maintain', price: 59 },
      { id: 'improve', name: 'Maintain + Improve', price: 99 }
    ],
    defaultPlan: 'maintain',

    // Signup records are emailed to you through Formspree.
    formspreeEndpoint: 'https://formspree.io/f/mojgoapk',

    // The signup Worker (code in _worker/, setup in _docs/ESIGN-SETUP.md), e.g.
    //   'https://sosg-signup.<your-subdomain>.workers.dev'
    // It verifies the customer's email, records the typed-name signature, keeps the signed PDFs + audit
    // trails privately, prices the order, and creates
    // the Stripe payment page only after a verified signature and the customer's approval of the amounts.
    // SAFE DEFAULT: empty. While empty, Step 2 tells customers to contact Scott and nobody can pay.
    signupApi: 'https://sosg-signup.wi64storage.workers.dev',

    // Public key that checks private invitations (made by: node _tools/make-invite.js --init-keys).
    // While null, every invitation link is refused and customers see regular pricing.
    invitePublicKey: null,

    // Show the "Have a promo code?" field on the Package step.
    allowPromoCodes: true
  };
});
