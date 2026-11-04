/** Prefill saved contacts without allowing an old response to replace a new email's draft. */
export function bindAdminInvitationLookup(form, lookup, t) {
  const emailInput = form.querySelector('[name="email"]');
  const status = form.querySelector("[data-invitation-lookup-status]");
  const fields = [
    "firstName",
    "lastName",
    "phone",
    "phoneExtension",
    "departmentId",
  ];
  let request;
  let timer;
  let filled = {};
  const email = () => emailInput.value.trim().toLowerCase();
  const announce = (key) => {
    status.textContent = key ? t(key) : "";
  };
  const clearFilled = () => {
    for (const [name, value] of Object.entries(filled)) {
      const input = form.querySelector(`[name="${name}"]`);
      if (input.value === value) input.value = "";
    }
    filled = {};
  };
  const updateExtension = () => {
    const expanded = Boolean(
      form.querySelector('[name="phoneExtension"]').value,
    );
    form.querySelector("[data-phone-extension]").hidden = !expanded;
    const add = form.querySelector("[data-add-extension]");
    add.hidden = expanded;
    add.setAttribute("aria-expanded", String(expanded));
  };
  const ensure = async () => {
    clearTimeout(timer);
    const target = email();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) return;
    if (request?.email !== target) {
      clearFilled();
      updateExtension();
      announce("admin.users.lookupLoading");
      const current = { email: target, promise: null };
      request = current;
      current.promise = Promise.resolve()
        .then(() => lookup(target))
        .then(({ profile }) => {
          if (request !== current || email() !== target || !form.isConnected)
            return;
          if (profile) {
            const department = form.querySelector('[name="departmentId"]');
            // Historical departments may no longer be in the active options list.
            if (
              profile.departmentId &&
              ![...department.querySelectorAll("wa-option")].some(
                (option) => option.value === profile.departmentId,
              )
            ) {
              const option = document.createElement("wa-option");
              option.value = profile.departmentId;
              option.textContent =
                profile.departmentName || profile.departmentId;
              department.append(option);
            }
            for (const name of fields) {
              const input = form.querySelector(`[name="${name}"]`);
              input.value = profile[name] || "";
              filled[name] = input.value;
            }
            updateExtension();
            form.dispatchEvent(new Event("input", { bubbles: true }));
          }
          announce(
            profile ? "admin.users.lookupFound" : "admin.users.lookupNew",
          );
        })
        .catch((error) => {
          if (request === current && email() === target) {
            request = undefined;
            announce("admin.users.lookupFailed");
          }
          throw error;
        });
    }
    await request.promise;
    // Submitting while the email changes must resolve the current address first.
    if (email() !== target) await ensure();
  };
  emailInput.addEventListener("input", () => {
    clearTimeout(timer);
    if (request?.email !== email()) {
      request = undefined;
      clearFilled();
      updateExtension();
      announce("");
    }
    timer = setTimeout(() => {
      void ensure().catch(() => {});
    }, 350);
  });
  emailInput.addEventListener("change", () => {
    void ensure().catch(() => {});
  });
  return ensure;
}
