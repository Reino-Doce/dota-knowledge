import { decimal } from './exact.mjs';
import { BUCKETS } from './timings-math.mjs';
import { WEEK_SECONDS } from './weeks.mjs';

export const calibrationSql = (lo, hi) => `
  SELECT match_id AS id, radiant_team AS r, dire_team AS d, radiant_win AS w
  FROM public_matches
  WHERE match_id > ${decimal(lo)} AND match_id <= ${decimal(hi)}
    AND lobby_type = 7 AND game_mode = 22
    AND array_length(radiant_team, 1) = 5 AND array_length(dire_team, 1) = 5`;

export const POSITIONS_QUERY = `query Positions($positions: [MatchPlayerPositionType], $brackets: [RankBracket], $modes: [GameModeEnumType], $take: Int, $skip: Int) {
  heroStats {
    winWeek(positionIds: $positions, bracketIds: $brackets, gameModeIds: $modes, take: $take, skip: $skip) {
      week heroId matchCount winCount
    }
  }
}`;

export const LANES_QUERY = `query Lanes($week: Long!, $isWith: Boolean!, $positions: [MatchPlayerPositionType], $brackets: [RankBracketBasicEnum]) {
  heroStats {
    laneOutcome(week: $week, isWith: $isWith, positionIds: $positions, bracketBasicIds: $brackets) {
      heroId1 heroId2 matchCount winCount drawCount lossCount matchWinCount stompWinCount stompLossCount
    }
  }
}`;

export const laneVariables = ({ week, position, direction, brackets }) => ({
  // The argument is the week's first second; the response's `week` field is a week number.
  week: week * WEEK_SECONDS,
  isWith: direction === "with",
  positions: [`POSITION_${position}`],
  brackets: brackets.length ? brackets : null,
});


export const HEROES_QUERY = "{ constants { heroes { id shortName displayName } } }";
export const bucketCase = () => {
  const arms = BUCKETS.filter((b) => b.maxSeconds !== null).map(
    (b, i) => `WHEN duration < ${b.maxSeconds} THEN ${i}`,
  );
  return `CASE ${arms.join(" ")} ELSE ${BUCKETS.length - 1} END`;
};

/**
 * One window of matches, folded to (hero, bucket, games, wins).
 *
 * Both sides of every game are unioned into one relation so a hero's row counts
 * their games wherever they were drafted, and the win flag is already read from
 * that hero's own side.
 */
export const timingSql = (lo, hi, options) => {
  const where = (extra = "") => `
    WHERE match_id > ${decimal(lo)} AND match_id <= ${decimal(hi)}
      AND lobby_type = 7 AND game_mode = 22
      AND duration > 600
      AND array_length(radiant_team, 1) = 5 AND array_length(dire_team, 1) = 5
      ${options.minRank ? `AND avg_rank_tier >= ${options.minRank}` : ""}${extra}`;

  return `
    WITH src AS (
      SELECT radiant_team AS team, radiant_win AS won, duration FROM public_matches
      ${where()}
      UNION ALL
      SELECT dire_team AS team, NOT radiant_win AS won, duration FROM public_matches
      ${where()}
    )
    SELECT unnest(team) AS hero,
           ${bucketCase()} AS bucket,
           count(*) AS games,
           count(*) FILTER (WHERE won) AS wins
      FROM src
     GROUP BY 1, 2`;
};

export const synergySql = (lo, hi, options) => `
  SELECT radiant_team AS t, radiant_win AS w FROM public_matches
  WHERE match_id > ${decimal(lo)} AND match_id <= ${decimal(hi)}
    AND lobby_type = 7 AND game_mode = 22
    AND array_length(radiant_team, 1) = 5 AND array_length(dire_team, 1) = 5
    ${options.minRank ? `AND avg_rank_tier >= ${options.minRank}` : ""}
  UNION ALL
  SELECT dire_team, NOT radiant_win FROM public_matches
  WHERE match_id > ${decimal(lo)} AND match_id <= ${decimal(hi)}
    AND lobby_type = 7 AND game_mode = 22
    AND array_length(radiant_team, 1) = 5 AND array_length(dire_team, 1) = 5
    ${options.minRank ? `AND avg_rank_tier >= ${options.minRank}` : ""}`;

