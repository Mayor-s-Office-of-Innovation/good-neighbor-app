/**
 * Status pills story — .pill / .pill--route / .pill--confirm / .pill--pending /
 * .pill--sev from app.css. The design rule they encode: text names the state,
 * color only reinforces (WCAG 1.4.1).
 */

export default {
  title: "Foundations/Status pills",
  parameters: { renderer: "html" },
  source: '<span class="pill pill--route">En route</span>',
};

export const Default = {
  name: "All variants",
  render: () => `
    <div class="story-row">
      <span class="pill pill--route">En route</span>
      <span class="pill pill--confirm">Confirm</span>
      <span class="pill pill--pending">Pending</span>
      <span class="pill pill--sev">Sev 2</span>
    </div>`,
};