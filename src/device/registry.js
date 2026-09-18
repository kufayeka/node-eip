'use strict';

/**
 * Universal CIP Profile Registry
 *
 * Stores and resolves registered PLC profiles across vendors and models.
 */

const profiles = new Map();

function normalizeKey(key) {
    return String(key).trim().toLowerCase();
}

function registerProfile(profile) {
    if (!profile || typeof profile.resolveAddress !== 'function') {
        throw new TypeError('registerProfile: profile must be a DeviceProfile instance');
    }

    const primaryKey = `${profile.vendor}:${profile.model}`.toLowerCase();
    profiles.set(primaryKey, profile);

    // Also register aliases
    if (profile.model) {
        profiles.set(normalizeKey(profile.model), profile);
    }
    if (profile.aliases && Array.isArray(profile.aliases)) {
        for (const alias of profile.aliases) {
            profiles.set(normalizeKey(alias), profile);
        }
    }

    return profile;
}

function getProfile(key) {
    const norm = normalizeKey(key);
    const profile = profiles.get(norm);
    if (!profile) {
        const available = [...new Set(profiles.keys())].join(', ') || '(none)';
        throw new Error(`Unknown device profile "${key}". Available profiles: ${available}`);
    }
    return profile;
}

function hasProfile(key) {
    return profiles.has(normalizeKey(key));
}

function listProfiles() {
    return [...new Set(profiles.values())];
}

module.exports = {
    registerProfile,
    getProfile,
    hasProfile,
    listProfiles
};
