/**
 * The built-in level pack.
 *
 * One object per level; adding a thirty-first means appending one more. Nothing
 * outside `packs.ts` reads this array, and `id` is what progress is keyed by, so
 * levels can be inserted or reordered without disturbing anyone's save.
 *
 * `solution` is a recorded winning run -- one character per player move, `U D L
 * R`, or `.` to stand still for a move while a slide or a force floor plays out.
 * `tests/beanchallenge.test.ts` replays every one and fails if a level has
 * become unwinnable, which is the only thing keeping thirty hand-drawn puzzles
 * honest. They are proofs, not par: several were found by a breadth-first search
 * and wander about accordingly.
 *
 * Every level ends the same way, and it is load-bearing rather than decorative:
 *
 *     #.#############
 *     #...........SE#
 *
 * The socket sits in the one square before the exit, at the end of a corridor
 * with a single mouth. Anything else lets the player drop into the bottom row to
 * the right of the socket and walk out with the beans still on the floor --
 * which is exactly what the search did to eight of these on its first run.
 *
 * The legend lives in `tiles.ts`. Briefly:
 *
 *     #  wall     .  floor    :  gravel   H  hint
 *     P  player   b  bean     S  socket   E  exit
 *     ~  water    %  fire     *  block    o  bomb    T  teleport
 *     r/R g/G y/Y c/C   key / door, four colours
 *     f  flippers   z  fire boots   k  skates   s  suction boots
 *     I  ice   7 F L J  ice corners, drawn like the two walls they have
 *     ^ v < >  force floors, ?  random
 *     X  toggle wall   x  toggle floor   !  green button
 *     B  bug   A  fireball   O  ball   W  walker
 */

import type { Level, Pack } from './level'

export const LEVELS: Level[] = [
  {
    id: 'first-steps',
    name: 'First Steps',
    time: 0,
    hint: 'Collect every bean, then walk through the socket to reach the exit.',
    solution: 'DDRRRRUURRRRRDDRRDDR',
    map: `
###############
#P...b....b...#
#.###.####.##.#
#...b......b..#
#.##########.##
#H..........SE#
###############`,
  },

  {
    id: 'under-lock',
    name: 'Under Lock',
    time: 0,
    hint: 'Keys open their own colour and are spent doing it. A block wedged in a dead end lets you past.',
    solution: 'RRRRRRRRRRRDDLLLLLLLLLLDDRRRRRRRRRRDDRLLLLLLLLLLLLDDRRRRRRRRRRRR',
    map: `
###############
#P..b.....b*..#
############.##
#..*..r..y....#
##.############
#...bR.b.Y.*..#
############.##
#H.b..b..b...b#
#.#############
#...........SE#
###############`,
  },

  {
    id: 'four-doors',
    name: 'Four Doors',
    time: 0,
    hint: 'Four keys up here, four doors below, one after another.',
    solution:
      'DDRRLLUURRRRRRRRRRRRRRDDLLLLLLLLDDDDDDDDDRRRRRRRLLLLLLLLLLLLLDDRRRRRRRRRRRRRR',
    map: `
#################
#P..r..b...g....#
#.#############.#
#..y.......c...b#
#######.#########
#######R#########
#######.#########
#######G#########
#######.#########
#######Y#########
#######.#########
#######C#########
#..b..........b.#
#.###############
#.............SE#
#################`,
  },

  {
    id: 'heavy-lifting',
    name: 'Heavy Lifting',
    time: 0,
    hint: 'A block moves one square, and only into an empty one. Push it to the end of the corridor and slip by.',
    solution: 'RRRRRRRRRRRDDLLLLLLLLLLDDRRRRRRRRRRDDLLLLLLLLLLDDRRRRRRRRRRRLLLLLLLLLLLLDDRRRRRRRRRRRR',
    map: `
###############
#P.b..b...*...#
############.##
#...*..b..b...#
##.############
#...b..b..*...#
############.##
#...*..b..b...#
##.############
#H..b...b....b#
#.#############
#...........SE#
###############`,
  },

  {
    id: 'bridge-out',
    name: 'Bridge Out',
    time: 0,
    hint: 'A block pushed into water fills it in. The block does not come back.',
    solution: 'DDRRDDRRDRRRRRRUUUUURRDDDDDDDLLLLLLLLLLLLDDRRRRRRRRRRRR',
    map: `
###############
#P..*..~~~..b.#
#.###.~~~~~.#.#
#b..#.~~~~~.#.#
#.#.#.~~~~~.#.#
#.#.*.~~~~~.*.#
#.#.#.......#.#
#.#.#########.#
#b..........b.#
#.#############
#...........SE#
###############`,
  },

  {
    id: 'deep-end',
    name: 'The Deep End',
    time: 0,
    hint: 'A block pushed into water fills it in. Flippers make the rest of the lake safe.',
    solution:
      'RRRRRRRRRRRRDDLLLLLLLLLLLLDDRRRRRRRRRRRRDDLLLLLLLLLLLLDDRRRR' +
      'RRRRRRRRLLLLLLLLLLLLDDRRRRRRRRRRRR',
    map: `
###############
#PH.b.....b.*~#
#############.#
#~*..b....b...#
#.#############
#..b.....b..*~#
#############.#
#~*..b....b...#
#.#############
#f.~~~~~~~~~~b#
#.#############
#...........SE#
###############`,
  },

  {
    id: 'hot-foot',
    name: 'Hot Foot',
    time: 0,
    hint: 'Fire boots let you walk through flame. They do nothing for water.',
    solution: 'RRRRRRRRRRRRDDDDDDDUUUULLLDDLLLLUULLDDDDLLLDDRRRRRRRRRRRR',
    map: `
###############
#P....z......b#
#.............#
#..%%%%%%%%%..#
#..%b%%%%%b%..#
#..%%%%%%%%%..#
#..%%%b%%%%%..#
#..%%%%%%%%%..#
#b...........b#
#.#############
#...........SE#
###############`,
  },

  {
    id: 'cold-comfort',
    name: 'Cold Comfort',
    time: 0,
    hint: 'On ice you keep going until something stops you. Clear each block to reach the next slide.',
    solution:
      'RRRRRRRRRRRDDRLLLLLLLLLLLLDDRRRRRRRRRRRDDRLLLLLLLLLLLLDDRRRR' +
      'RRRRRRRDDRLLLLLLLLLLLLDDRRRRRRRRRRRR',
    map: `
###############
#PHb.....b*...#
############.##
#.IIIIIIIIII.b#
#.#############
#..b.....b*...#
############.##
#.IIIIIIIIII.b#
#.#############
#..b.....b*...#
############.##
#.IIIIIIIIII.b#
#.#############
#...........SE#
###############`,
  },

  {
    id: 'slip-road',
    name: 'Slip Road',
    time: 0,
    hint: 'A corner turns you. Its rails are the two sides it will not let you out.',
    /*
     * The chute is the only way down, and it is one ride: east along row 3, the
     * NE corner turns you south, the SE corner west, the NW corner south again,
     * the SW corner east, and the floor at the end of row 7 is what stops you.
     * A ring of ice with no floor in it would be a trap -- you never get a move
     * back to steer with -- so this one is deliberately a spiral, not a loop.
     */
    solution:
      'RRRRRRRRRRRRDLLLLLLLLLLLLDR' +
      'UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU' +
      'DDLLLLLLLLLLLLDDRRRRRRRRRRRR',
    map: `
###############
#P...........b#
#.............#
#.IIIIIIIIII7.#
#.##########I##
#FIIIIIIIIIIJ.#
#I###########.#
#LIIIIIIIIIII.#
#.###########.#
#b....b.b....b#
#.#############
#...........SE#
###############`,
  },

  {
    id: 'skate-park',
    name: 'Skate Park',
    time: 0,
    hint: 'Skates cancel the ice for good. Reaching them is the puzzle, and blocks are in the way.',
    solution:
      'RRRRRRRRRRRDDDDDDDRLLLLLLLLLLLDDLRUURRRRRRRRRRUULLLLLLLLUULL' +
      'RRRRRRRRRRDDDDLLLLLLLLLLDDRRRRRRRRRDDRR',
    map: `
###############
#PHb...b...*..#
############.##
#IIIIIIIIIIIII#
#IbIIIbIIIbIII#
#IIIIIIIIIIIII#
#IIIbIIIbIIIII#
############I##
#..*.........b#
##.############
#k.b.b.b.*....#
###########.###
#...........SE#
###############`,
  },

  {
    id: 'conveyor',
    name: 'Conveyor',
    time: 0,
    hint: 'A force floor takes the choice away. See where it leads before you step.',
    solution: 'DDDDRRRRRLLLLLDDDDRRRRRRRRRRRR',
    map: `
###############
#P>>>>>>>>>>v.#
#.##########v##
#b..........v##
#.##########v##
#b....b.....v##
#.##########v##
#b...........##
#.#############
#...........SE#
###############`,
  },

  {
    id: 'wind-tunnel',
    name: 'Wind Tunnel',
    time: 240,
    hint: 'Suction boots plant your feet. Without them this floor is one-way.',
    solution: 'DDUUDRRURRRRRDRRRRRUUUUULLLLLLLLLLLLUURRRRRRRRRRRR',
    map: `
###############
#...........SE#
#.#############
#P...........b#
#.###########.#
#vvvvvvvvvvvvv#
#vvvvvvvvvvvvv#
#b....b.b....b#
#..s.........b#
###############`,
  },

  {
    id: 'bug-hunt',
    name: 'Bug Hunt',
    time: 240,
    hint: 'A bug hugs the wall on its left. Learn its lap and step in behind it.',
    solution: 'RRRRRRRRRRRRDDDDDDDLLLLLLUUULRRULUULLLLLDDDDDDLDDRRRRRRRRRRRR',
    map: `
###############
#P...........b#
#.............#
#..####.####..#
#..#B.....B#..#
#..#..b.b..#..#
#..#B.....B#..#
#..####.####..#
#b...........b#
#.#############
#...........SE#
###############`,
  },

  {
    id: 'bounce',
    name: 'Bounce',
    time: 240,
    hint: 'A ball runs a straight line and turns round at the end of it.',
    solution: 'RRRRRRRRRRRRDDDDDDLRUUUULRUULLLLLLLLLLLLDDDDRLDDDDRRRRRRRRRRRR',
    map: `
###############
#P...........b#
#.###########.#
#.O.........b.#
#.###########.#
#.b.........O.#
#.###########.#
#.O.........b.#
#.#############
#b..........SE#
###############`,
  },

  {
    id: 'spark',
    name: 'Spark',
    time: 240,
    hint: 'Fireballs hug the wall on their right, and flame does not slow them.',
    solution: 'UURRRRRRRRRRRRDDDDDDDLLLLLLUUULRRDLDDLLLLLLDDRRRRRRRRRRRR',
    map: `
###############
#P...........b#
#.............#
#..####.####..#
#..#A.....%#..#
#..#..b.b..#..#
#..#%.....A#..#
#..####.####..#
#b...........b#
#.#############
#...........SE#
###############`,
  },

  {
    id: 'drunkards-walk',
    name: "Drunkard's Walk",
    time: 260,
    hint: 'Walkers wander. There is no pattern to read, only room to keep away.',
    /* The one level a breadth-first search could not crack -- a walker's turn
       depends on the whole history of the seed, so states that look alike are
       not. This run came from a greedy walk that stands still when the next
       square is about to be occupied. */
    solution: 'DDDDDDDRRRRDLDU.RUULURRRRURRLUUURRRRDDDDRLDDDRLLLLLLLLLLLLDDRRRRRRRRRRRR',
    map: `
###############
#P...........b#
#.............#
#..##.###.##..#
#..#W.....b#..#
#..#..b.b..#..#
#..#b.....W#..#
#..##.###.##..#
#b...........b#
#.#############
#...........SE#
###############`,
  },

  {
    id: 'gravel-pit',
    name: 'Gravel Pit',
    time: 240,
    hint: 'Gravel takes your weight but nothing else. Monsters will not cross it.',
    solution: 'DDDDRRRRRRUURRUURRRRDDDDDDDDLLLLLLLLLLLLDDRRRRRRRRRRRR',
    map: `
###############
#P...:...:...b#
#.###:###:###.#
#.#B.:...:.B#.#
#.#..:...:..#.#
#b:::::b:::::b#
#.#..:...:..#.#
#.#B.:...:.B#.#
#.###:###:###.#
#b...:...:...b#
#.#############
#...........SE#
###############`,
  },

  {
    id: 'flip-flop',
    name: 'Flip-Flop',
    time: 0,
    hint: 'The green button swaps every toggle wall for a floor, and back again.',
    solution: 'RRRRRRRRRRRRDDDDDDDLLLLLLLUUURRDDDLLLLLLLDDRRRRRRRRRRRR',
    map: `
###############
#P...........b#
#.............#
#..XXXXXXXXX..#
#..X.......X..#
#..X..b.b..X..#
#..X.......X..#
#..XXXXXXXXX..#
#b....!......b#
#.#############
#...........SE#
###############`,
  },

  {
    id: 'wormhole',
    name: 'Wormhole',
    time: 0,
    hint: 'Teleports form one loop, in reading order. Step on one to ride it.',
    solution: 'RRRRRRLLURRRDRLLRRRRRRDDDDDDDLLLLLLLLLLLLDDRRRRRRRRRRRR',
    map: `
###############
#P.....T.....b#
#.............#
#.###########.#
#.#.........#.#
#.#..b.T.b..#.#
#.#.........#.#
#.###########.#
#b...........b#
#.#############
#...........SE#
###############`,
  },

  {
    id: 'minefield',
    name: 'Minefield',
    time: 240,
    hint: 'A bomb ends you. A block pushed onto one ends the bomb instead.',
    /* The bomb in the mouth of the last corridor is the one that has to be
       defused rather than walked around. */
    solution: 'RRRRRRRRRRRRDDDDDDDLLLLLLLLLLLLUUUUUDDDDDRRRRRRDDDRRRRRR',
    map: `
###############
#P...........b#
#.............#
#b...o...o...b#
#.#.#####.#.#.#
#..*.......*..#
#.#.#####.#.#.#
#b...o...o...b#
#.............#
#......*......#
#######o#######
#...........SE#
###############`,
  },

  {
    id: 'keyring',
    name: 'Keyring',
    time: 0,
    hint: 'Two of each key, and doors that eat one apiece. Count before you spend.',
    solution:
      'DDUURRRRRDDLDDRRRUUUURRDDDDRRRUULUURRRDDDDDDLLLLLLLLLLLLLLDDDDRRRRRRRRRRRRRR',
    map: `
#################
#P..r..#b..#..r.#
#.####.#.#.#.##.#
#b..#..#.#.#..#b#
#.#.#.##.#.##.#.#
#.#R#....#....#R#
#.#.###########.#
#...b.........b.#
#.###############
#b..............#
#.###############
#.............SE#
#################`,
  },

  {
    id: 'ice-house',
    name: 'Ice House',
    time: 260,
    hint: 'Ice and company. A monster on the far side of a slide cannot reach you.',
    solution:
      'UDDDDDDDDRRRRRRRRRRUUUURRLLUUDDDLUUURUURUULLLLLLLLRRRRRRRRDDLDDLDDDD' +
      'LLLLLLLLLLDDRRRRRRRRRRRR',
    map: `
###############
#P..#b......b.#
#.#.#.#######.#
#.#.#IIIIII#..#
#.#.#I####I#.##
#.#.#I#B.I#..b#
#.#.#I#..I#.###
#b..#IIIII#...#
#.#########.#.#
#b.........b..#
#.#############
#...........SE#
###############`,
  },

  {
    id: 'crosswinds',
    name: 'Crosswinds',
    time: 240,
    hint: 'The floor decides where you go. All you choose is where you step on.',
    /* Four one-way rides, alternating ends. There is no walk-around: the rows
       between them are solid but for the single square each ride lands on. */
    solution:
      'RRRRRRRRRRRRLLLLLLLLLLLLDD............DD............DD............' +
      'DDLLLLLLLLLLLLDDRRRRRRRRRRRR',
    map: `
###############
#P...........b#
#.#############
#>>>>>>>>>>>>.#
#############.#
#.<<<<<<<<<<<<#
#.#############
#>>>>>>>>>>>>.#
#############.#
#b....b.b....b#
#.#############
#...........SE#
###############`,
  },

  {
    id: 'firewalk',
    name: 'Firewalk',
    time: 260,
    hint: 'Fire boots are the only way across the last band. Find them first.',
    solution: 'DDDDDDRRRRRRRRRRRRUUUUUUDDDDDDLLLLLLLLLLLLDDDDRRRRRRRRRRRR',
    map: `
###############
#P..*..%..*..b#
#.#.#.#.#.#.#.#
#b..%..*..%..b#
#.#.#.#.#.#.#.#
#..*..%..*....#
#.###########.#
#b..z........b#
#.###########.#
#%%%%%%%%%%%%%#
#.#############
#...........SE#
###############`,
  },

  {
    id: 'block-party',
    name: 'Block Party',
    time: 280,
    hint: 'The moat runs the whole width. One block, pushed twice, is a bridge.',
    solution:
      'RRRRRRRRRRRRLLLLLLLLLDDLLLRRRRRRRRRRRRLLLLLLLLLDDLLLRRRRRRRRRRRR' +
      'LLLLLLLLLLLLDDDDRRRRRRRRRRRR',
    map: `
###############
#P...........b#
#...*...*...*.#
#b...........b#
#~~~~~~~~~~~~~#
#b...........b#
#.............#
#...*...*...*.#
#.#############
#...........SE#
###############`,
  },

  {
    id: 'the-gauntlet',
    name: 'The Gauntlet',
    time: 280,
    hint: 'Water, fire, ice and a bug, in that order. The boots are on the way.',
    solution: 'DDDDDDUUUUUURRRRRRRRRRRRRRDDLDDDDDDDRDDLLLLLLLLLLLLLLDDRRRRRRRRRRRRRR',
    map: `
#################
#P..f..~~~~~..b.#
#.####.~~~~~.##.#
#b..z#.~~~~~.#..#
#.##.#.......#.##
#..#.#%%%%%%%#..#
#.##.#%%%%%%%#.##
#b.#.#.......#..#
#..#.#IIIIIII#.##
#.##.#IIIIIII#..#
#..k.#IIIIIII#.b#
#.####...B...##.#
#b.............b#
#.###############
#.............SE#
#################`,
  },

  {
    id: 'switchback',
    name: 'Switchback',
    time: 280,
    hint: 'The button is on the far side of the wall it opens. Take the long way.',
    solution: 'DDDDRRUURRUUDDRRRRRRRRUUDDDDDDDDUULLLLLLDDLLUULLDDLLDUDDRRRRRRRRRRRR',
    map: `
###############
#P..#b..#T..#b#
#.#.#.#.#.#.#.#
#..X..X..X..X.#
#.#.#.#.#.#.#.#
#b.!#...#...#b#
#.#########.#.#
#..X..X..X..X.#
#.#.#.#.#.#.#.#
#T..#b..#..!#b#
#.#############
#...........SE#
###############`,
  },

  {
    id: 'cold-storage',
    name: 'Cold Storage',
    time: 280,
    hint: 'Sliding onto a bomb is still stepping on it. The skates are the way out.',
    solution: 'DDUURRUUUUUUUUUUDDDDDDUULUUUUUUUUUULDDDDDDRRRRRRRRRRRR',
    map: `
###############
#P.IIIIIIIIII.#
#.#.#.#.#.#.#.#
#b.o.......o.b#
#.#.#.#.#.#.#.#
#..IIIIIIIIII.#
#.#.#.#.#.#.#.#
#b.o...k...o.b#
#.#.#.#.#.#.#.#
#..IIIIIIIIII.#
#.#############
#...........SE#
###############`,
  },

  {
    id: 'beanstalk',
    name: 'Beanstalk',
    time: 300,
    hint: 'Three bands to get through. What each one needs is lying in the strip above it.',
    solution:
      'RRRRRRRRRRRRRRLLLLLLLLLLLLLLDD' +
      'RRRRRRRRRRRRRRLLLLLLLLLLLLLLDD' +
      'RRRRRRRRRRRRRRDD' +
      'LLLLLLLLLLLLLLDD' +
      'RRRRRRRRRRRRRR',
    map: `
#################
#P...f...b.....b#
#~~~~~~~~~~~~~~~#
#b...z...b.....b#
#%%%%%%%%%%%%%%%#
#b......!b.....b#
#XXXXXXXXXXXXXXX#
#b.......b.....b#
#.###############
#.............SE#
#################`,
  },

  {
    id: 'last-bean',
    name: 'The Last Bean',
    time: 300,
    hint: 'One of everything, in the order you meet it. The last band wants a block.',
    /*
     * The button sits in the doorway of its own row rather than out along it, so
     * walking the row and coming back does not press it a second time and shut
     * the toggle wall again. That mistake cost an afternoon.
     */
    solution:
      'RRRRRRRRRRRRRRLLLLLLLLLLLLLLDD' +
      'RRRRRRRRRRRRRRLLLLLLLLLLLLLLDD' +
      'RRRRRRRRRRRRRRLLLLLLLLLLLLLLDD' +
      'RRRRRRRRRRRRRRDD' +
      'LLLLLLLLLLLLLLRRRRRRRRRRRRRRDD' +
      'LLLLLLLLLLLLLLDD' +
      'RRRRRRRRRRRRRR',
    map: `
#################
#P...f...b.....b#
#~~~~~~~~~~~~~~~#
#b...z...b.....b#
#%%%%%%%%%%%%%%%#
#b...r...b.....b#
#R###############
#!.......b.....b#
#XXXXXXXXXXXXXXX#
#b.......b...b.*#
###############o#
#b.......b.....b#
#.###############
#.............SE#
#################`,
  },
]

export const CLASSIC: Pack = {
  id: 'classic',
  name: 'Classic',
  levels: LEVELS,
}
