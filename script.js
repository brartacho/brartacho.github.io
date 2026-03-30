function init() {
    bindUIEvents();
    handleProfileImageLoad();
    initTypeWriter();
    initTabs();
    initAccordions();
}

function initTypeWriter() {
    const nameEl = document.getElementById("name-header");
    if (!nameEl) return;

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const text = nameEl.getAttribute("data-text") || nameEl.textContent || "";

    if (prefersReducedMotion) {
        nameEl.textContent = text;
        return;
    }

    nameEl.textContent = "";

    Array.from(text).forEach((char, index) => {
        setTimeout(() => {
            nameEl.textContent += char;
        }, index * 55);
    });
}

function handleProfileImageLoad() {
    const img = document.querySelector(".profile-img");
    if (!img) return;

    const triggerFadeIn = () => {
        requestAnimationFrame(() => {
            img.classList.add("loaded");
        });
    };

    if (img.complete && img.naturalHeight !== 0) {
        triggerFadeIn();
    } else {
        img.addEventListener("load", triggerFadeIn, { once: true });
        img.addEventListener("error", triggerFadeIn, { once: true });
    }
}

function bindUIEvents() {
    const hamburger = document.getElementById("hamburger");
    const navLinks = document.getElementById("navLinks");
    const overlay = document.getElementById("menuOverlay");

    if (!hamburger || !navLinks || !overlay) return;

    const navItems = document.querySelectorAll(".nav-links a, .logo");
    const mobileQuery = window.matchMedia("(max-width: 767px)");

    function setExpandedState(isExpanded) {
        hamburger.setAttribute("aria-expanded", String(isExpanded));
    }

    function closeMenu() {
        hamburger.classList.remove("active");
        navLinks.classList.remove("active");
        overlay.classList.remove("active");
        document.body.classList.remove("menu-open");
        setExpandedState(false);
    }

    function openMenu() {
        hamburger.classList.add("active");
        navLinks.classList.add("active");
        overlay.classList.add("active");
        document.body.classList.add("menu-open");
        setExpandedState(true);
    }

    function toggleMenu(event) {
        event.stopPropagation();
        if (hamburger.classList.contains("active")) {
            closeMenu();
            return;
        }
        openMenu();
    }

    navItems.forEach((link) => {
        link.addEventListener("click", () => {
            if (mobileQuery.matches) {
                closeMenu();
            }
        });
    });

    hamburger.addEventListener("click", toggleMenu);
    overlay.addEventListener("click", closeMenu);

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            closeMenu();
        }
    });

    const handleMediaChange = (event) => {
        if (!event.matches) {
            closeMenu();
        }
    };

    if (typeof mobileQuery.addEventListener === "function") {
        mobileQuery.addEventListener("change", handleMediaChange);
    } else if (typeof mobileQuery.addListener === "function") {
        mobileQuery.addListener(handleMediaChange);
    }

    setExpandedState(false);
}

function initTabs() {
    const groups = document.querySelectorAll("[data-doc-tabs], [data-tab-group]");
    if (!groups.length) return;

    groups.forEach((group, groupIndex) => {
        const buttons = group.querySelectorAll("[data-tab-target]");
        const panes = group.querySelectorAll("[data-tab-pane]");

        if (!buttons.length || !panes.length) return;

        const activateTab = (button) => {
            const target = button.getAttribute("data-tab-target");
            if (!target) return;

            buttons.forEach((item, buttonIndex) => {
                const itemTarget = item.getAttribute("data-tab-target");
                const tabId = `tab-${groupIndex}-${buttonIndex}`;
                const panelId = `panel-${groupIndex}-${itemTarget}`;

                item.classList.remove("active");
                item.setAttribute("aria-selected", "false");
                item.setAttribute("tabindex", "-1");
                item.id = tabId;
                item.setAttribute("aria-controls", panelId);
            });

            panes.forEach((pane) => {
                pane.classList.remove("active");
                pane.hidden = true;
            });

            button.classList.add("active");
            button.setAttribute("aria-selected", "true");
            button.setAttribute("tabindex", "0");

            const pane = group.querySelector(`[data-tab-pane="${target}"]`);
            if (pane) {
                pane.classList.add("active");
                pane.hidden = false;
                pane.id = `panel-${groupIndex}-${target}`;
                pane.setAttribute("aria-labelledby", button.id);
            }
        };

        buttons.forEach((button) => {
            button.setAttribute("tabindex", button.classList.contains("active") ? "0" : "-1");
            button.addEventListener("click", () => {
                activateTab(button);
            });

            button.addEventListener("keydown", (event) => {
                const currentIndex = Array.from(buttons).indexOf(button);
                if (currentIndex === -1) return;

                if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                    event.preventDefault();
                    const nextButton = buttons[(currentIndex + 1) % buttons.length];
                    activateTab(nextButton);
                    nextButton.focus();
                }

                if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                    event.preventDefault();
                    const nextButton = buttons[(currentIndex - 1 + buttons.length) % buttons.length];
                    activateTab(nextButton);
                    nextButton.focus();
                }

                if (event.key === "Home") {
                    event.preventDefault();
                    activateTab(buttons[0]);
                    buttons[0].focus();
                }

                if (event.key === "End") {
                    event.preventDefault();
                    const lastButton = buttons[buttons.length - 1];
                    activateTab(lastButton);
                    lastButton.focus();
                }
            });
        });

        panes.forEach((pane) => {
            pane.hidden = !pane.classList.contains("active");
        });

        const activeButton = group.querySelector("[data-tab-target].active") || buttons[0];
        activateTab(activeButton);
    });
}

function initAccordions() {
    const groups = document.querySelectorAll("[data-accordion-group]");
    if (!groups.length) return;

    groups.forEach((group, groupIndex) => {
        const items = group.querySelectorAll(".accordion-item");

        items.forEach((item, itemIndex) => {
            const trigger = item.querySelector(".accordion-trigger");
            const content = item.querySelector(".accordion-content");
            if (!trigger) return;

            const contentId = `accordion-panel-${groupIndex}-${itemIndex}`;
            const triggerId = `accordion-trigger-${groupIndex}-${itemIndex}`;
            const isActive = item.classList.contains("active");

            trigger.id = triggerId;
            trigger.setAttribute("aria-controls", contentId);
            trigger.setAttribute("aria-expanded", String(isActive));

            if (content) {
                content.id = contentId;
                content.setAttribute("aria-labelledby", triggerId);
                content.hidden = !isActive;
            }

            trigger.addEventListener("click", () => {
                const isActive = item.classList.contains("active");

                items.forEach((entry) => {
                    const entryTrigger = entry.querySelector(".accordion-trigger");
                    const entryContent = entry.querySelector(".accordion-content");

                    entry.classList.remove("active");
                    if (entryTrigger) {
                        entryTrigger.setAttribute("aria-expanded", "false");
                    }
                    if (entryContent) {
                        entryContent.hidden = true;
                    }
                });

                if (!isActive) {
                    item.classList.add("active");
                    trigger.setAttribute("aria-expanded", "true");
                    if (content) {
                        content.hidden = false;
                    }
                }
            });
        });
    });
}

init();
