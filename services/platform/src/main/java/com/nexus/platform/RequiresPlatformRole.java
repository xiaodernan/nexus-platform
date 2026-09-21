package com.nexus.platform;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/** Admin console guard (§9): the user's {@code users.role} must be one of these. Writes are audited. */
@Target({ElementType.METHOD, ElementType.TYPE})
@Retention(RetentionPolicy.RUNTIME)
public @interface RequiresPlatformRole {

    String[] value() default {"platform_admin", "platform_ops"};
}
