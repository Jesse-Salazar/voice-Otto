// Serialized into Puppeteer's page context. Keep the DOM checks self-contained.
function inspectProposalPage(expectedPath, mode, stagedExtension) {
  const empty = state => mode === "controls" ? { state } : state;
  if (location.origin !== "https://voice123.com" ||
      location.pathname.replace(/\/$/, "") !== expectedPath.replace(/\/$/, "")) {
    return mode === "confirmation" ? false : empty("wrong-project");
  }
  const panels = document.querySelectorAll(".project-management.specs .project-specs .project-info.post-offer");
  if (panels.length !== 1) return mode === "confirmation" ? false : empty("unknown-layout");
  const [panel] = panels;
  const visible = element => {
    if (!element?.isConnected || !element.getClientRects().length ||
        getComputedStyle(element).visibility !== "visible" || element.closest('[hidden], [aria-hidden="true"]')) return false;
    for (let current = element; current; current = current.parentElement) {
      if (Number(getComputedStyle(current).opacity) === 0) return false;
    }
    return true;
  };

  if (mode === "confirmation" || mode === "existing-confirmation") {
    const statuses = [...panel.querySelectorAll('[role="status"], [role="alert"], .proposal-status')]
      .filter(visible).map(node => node.innerText.trim());
    const success = statuses.filter(text => /^(?:your )?proposal (?:was |has been )?submitted successfully[.!]?$/i.test(text));
    if (mode === "existing-confirmation") return success.length > 0;
    const conflict = [...document.querySelectorAll('[role="alert"], [role="status"], .proposal-status')]
      .filter(visible).some(node => {
        const text = node.innerText.trim();
        return (panel.contains(node) || /\b(?:proposal|submission)\b/i.test(text)) &&
          /\b(?:error|fail(?:ed|ure)?|not (?:been )?submitted|draft|unsuccessful)\b/i.test(text);
      });
    return success.length === 1 && !conflict;
  }

  const forms = document.querySelectorAll('form[id="post-offer-form"]');
  const inputs = panel.querySelectorAll('input[type="file"]');
  const submits = document.querySelectorAll('[id="submit"]');
  if (forms.length !== 1 || inputs.length !== 1 || submits.length !== 1) return empty("missing-or-ambiguous");
  const [form] = forms;
  const [input] = inputs;
  const [submit] = submits;
  const inputContainer = input.closest(".upload-box-container");
  const submitContainer = submit.closest(".submit-options");
  if (!panel.contains(form) || !panel.contains(inputContainer) || !panel.contains(submitContainer) ||
      inputContainer.parentElement?.closest(".form-content .vdl-uploader")?.closest(".post-offer") !== panel ||
      submit.localName !== "button" || !/^submit(?: proposal)?$/i.test(submit.innerText.trim())) return empty("unknown-layout");

  // Observed: a FormKit form is present, but its uploader and button are
  // siblings of the form within the same proposal panel. Also recognize a
  // hypothetical version that associates both controls with the native form.
  const observed = !input.form && !submit.form && submit.type === "button" &&
    !input.hasAttribute("form") && !submit.hasAttribute("form");
  const native = input.form === form && submit.form === form && ["button", "submit"].includes(submit.type);
  if (!observed && !native) return empty("wrong-form");
  const accepted = input.accept.toLowerCase().split(",").map(value => value.trim());
  const audioTypes = stagedExtension === ".wav" ? [".wav", "audio/wav", "audio/x-wav"] : [".mp3", "audio/mpeg", "audio/mp3"];
  if (!accepted.some(value => value === "audio/*" || audioTypes.includes(value))) return empty("wrong-file-type");

  if (!visible(form) || !visible(input) || !visible(submit)) return empty("hidden");
  const disabled = el => el.matches(":disabled") || Boolean(el.closest('[disabled], [aria-disabled="true"], [inert], .disabled')) ||
    getComputedStyle(el).pointerEvents === "none";
  if (disabled(form) || disabled(input) || disabled(submit)) return empty("disabled");
  return mode === "controls" ? { state: "ready", input, submit } : "ready";
}

module.exports = { inspectProposalPage };
