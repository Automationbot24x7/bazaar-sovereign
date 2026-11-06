// Same roster as the server, importable without starting it.
export const ROSTER_FOR_TESTS = [
  { id: 'you', slug: 'player', art: 'player', name: 'Your House', player: true, color: '#e0a526', persona: 'The player.', model: 'claude-haiku-5-5' },
  { id: 'teodora', slug: 'teodora', art: 'teodora', name: 'Teodora', color: '#5aa469', model: 'claude-sonnet-5-5',
    persona: 'An elderly tea and salt trader with forty years at the same stall. Patient and cautious, hates debt, loves festivals, never panics. Calls younger merchants "children".',
    profile: { bio: 'Forty years at the same tea-and-salt stall. Patient, debt-shy, and never panics.', opening: 'Steady trade in cheap staples, saving her strength for festivals.' } },
  { id: 'kasim', slug: 'kasim', art: 'kasim', name: 'Kasim', color: '#d35d47', model: 'claude-haiku-5-5',
    persona: 'A loud, fast-talking young hawker who wins customers by always being the cheapest stall. Thin margins, high volume, a little reckless, loves a bargain and a boast.',
    profile: { bio: 'Young, loud and fast. Wins customers by always being the cheapest stall in town.', opening: 'Undercuts everyone on everything: thin margins, big volume.' } },
  { id: 'vey', slug: 'vey', art: 'vey', name: 'Vey', color: '#8e6cc9', model: 'claude-sonnet-5-5',
    persona: 'An aristocratic silk merchant who sells quality to the rich at high margins and refuses to scrap over coppers. Disdains Kasim. Calls people "darling".',
    profile: { bio: 'Silk merchant to the nobility. Will not haggle in the dust over coppers.', opening: 'Premium silk: few sales, fat margins, loyal rich customers.' } },
  { id: 'ozzo', slug: 'ozzo', art: 'ozzo', name: 'Ozzo', color: '#3b8bd0', model: 'claude-opus-5-5',
    persona: 'A monk turned merchant who never forgets a rumor. Bold, greedy and scheming; tries to corner whatever market is about to spike. Thinks slowly and deeply, plans several moves ahead.',
    profile: { bio: 'A monk turned merchant who never forgets a rumor, and never forgives a debt.', opening: 'Waits for a rumor, then tries to corner the good that is about to spike.' } },
];
