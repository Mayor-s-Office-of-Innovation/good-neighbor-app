/**
 * Web Awesome form controls story — the canonical usage pattern from
 * docs/frontend-design-system.md "Forms": WA controls theme themselves off the
 * --wa-* tokens; drop them into a stack and let them theme. Submit is native.
 */

export default {
  title: "Web Awesome/Form controls",
  parameters: { renderer: "html" },
  source: () => `/* Canonical usage (design doc, Forms):
<div class="stack">
  <wa-input label="Place name" type="text"></wa-input>
  <wa-textarea label="Describe the issue" resize="vertical" rows="4"></wa-textarea>
  <wa-checkbox>Include photo</wa-checkbox>
</div>
<button class="btn-ink" type="submit">Submit</button> */`,
};

export const Default = {
  name: "Canonical usage",
  render: () => `
    <form class="story-stack" style="align-items:stretch; width:min(360px, 100%)"
      onsubmit="return false">
      <wa-input label="Place name" type="text" autocomplete="off"></wa-input>
      <wa-textarea label="Describe the issue" resize="vertical" rows="3"></wa-textarea>
      <wa-checkbox checked>Include a photo</wa-checkbox>
      <div class="story-row" style="justify-content:flex-start; margin-top:0.5rem">
        <button class="btn-ink" type="submit">Submit</button>
        <button class="btn-outline" type="button">Cancel</button>
      </div>
    </form>`,
  source: () => `/* Canonical usage (design doc, Forms):
<div class="stack">
  <wa-input label="Place name" type="text"></wa-input>
  <wa-textarea label="Describe the issue" resize="vertical" rows="3"></wa-textarea>
  <wa-checkbox checked>Include a photo</wa-checkbox>
</div>
<button class="btn-ink" type="submit">Submit</button> */`,
};

export const Otp = {
  name: "OTP input (login)",
  render: () => `
    <div class="story-stack" style="width:min(360px, 100%)">
      <wa-otp-input label="Site code" length="6" type="alphanumeric" case="upper"></wa-otp-input>
    </div>`,
  source:
    '<wa-otp-input label="Site code" length="6" type="alphanumeric" case="upper"></wa-otp-input>',
};