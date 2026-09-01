UPDATE `image_builds` AS `obsolete`
SET `status` = 'stale',
    `error` = 'superseded by bundle ' || (
      SELECT `newer`.`rev`
      FROM `image_builds` AS `newer`
      WHERE `newer`.`id` <> `obsolete`.`id`
        AND `newer`.`organization_id` IS `obsolete`.`organization_id`
        AND `newer`.`scenario_id` = `obsolete`.`scenario_id`
        AND `newer`.`arch` = `obsolete`.`arch`
        AND `newer`.`content_hash` <> `obsolete`.`content_hash`
        AND `newer`.`created_at` > `obsolete`.`created_at`
      ORDER BY `newer`.`created_at` DESC, `newer`.`id` DESC
      LIMIT 1
    )
WHERE (
    `obsolete`.`status` = 'failed'
    OR (
      `obsolete`.`status` = 'stale'
      AND (
        `obsolete`.`error` IS NULL
        OR substr(
          `obsolete`.`error`,
          1,
          length('superseded by bundle ')
        ) <> 'superseded by bundle '
      )
    )
  )
  AND EXISTS (
    SELECT 1
    FROM `image_builds` AS `newer`
    WHERE `newer`.`id` <> `obsolete`.`id`
      AND `newer`.`organization_id` IS `obsolete`.`organization_id`
      AND `newer`.`scenario_id` = `obsolete`.`scenario_id`
      AND `newer`.`arch` = `obsolete`.`arch`
      AND `newer`.`content_hash` <> `obsolete`.`content_hash`
      AND `newer`.`created_at` > `obsolete`.`created_at`
  );
