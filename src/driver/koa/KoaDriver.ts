import {Action} from "../../Action";
import {ActionMetadata} from "../../metadata/ActionMetadata";
import {BaseDriver} from "../BaseDriver";
import {Driver} from "../Driver";
import {MiddlewareMetadata} from "../../metadata/MiddlewareMetadata";
import {ParamMetadata} from "../../metadata/ParamMetadata";
import {UseMetadata} from "../../metadata/UseMetadata";
import {classToPlain} from "class-transformer";
import {KoaMiddlewareInterface} from "./KoaMiddlewareInterface";
import {AuthorizationCheckerNotDefinedError} from "../../error/AuthorizationCheckerNotDefinedError";
import {AccessDeniedError} from "../../error/AccessDeniedError";
import {isPromiseLike} from "../../util/isPromiseLike";
import {getFromContainer} from "../../container";
import {RoleChecker} from "../../RoleChecker";
import {AuthorizationRequiredError} from "../../error/AuthorizationRequiredError";
import { NotFoundError, HttpError } from "../../index";
const cookie = require("cookie");
const templateUrl = require("template-url");

/**
 * Integration with koa framework.
 */
export class KoaDriver extends BaseDriver implements Driver {

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(public koa?: any, public router?: any) {
        super();
        this.loadKoa();
        this.loadRouter();
    }

    // -------------------------------------------------------------------------
    // Public Methods
    // -------------------------------------------------------------------------

    /**
     * Initializes the things driver needs before routes and middleware registration.
     */
    initialize() {
        const bodyParser = require("koa-bodyparser");
        this.koa.use(bodyParser());
        if (this.cors) {
            const cors = require("kcors");
            if (this.cors === true) {
                this.koa.use(cors());
            } else {
                this.koa.use(cors(this.cors));
            }
        }
    }

    /**
     * Registers middleware that run before controller actions.
     */
    registerMiddleware(middleware: MiddlewareMetadata): void {
        if ((middleware.instance as KoaMiddlewareInterface).use) {
            this.koa.use(function (ctx: any, next: any) {
                return (middleware.instance as KoaMiddlewareInterface).use(ctx, next);
            });
        }
    }

    /**
     * Registers action in the driver.
     */
    registerAction(actionMetadata: ActionMetadata, executeCallback: (options: Action) => any): void {

        // middlewares required for this action
        const defaultMiddlewares: any[] = [];
        if (actionMetadata.isFileUsed || actionMetadata.isFilesUsed) {
            const multer = this.loadMulter();
            actionMetadata.params
                .filter(param => param.type === "file")
                .forEach(param => {
                    defaultMiddlewares.push(multer(param.extraOptions).single(param.name));
                });
            actionMetadata.params
                .filter(param => param.type === "files")
                .forEach(param => {
                    defaultMiddlewares.push(multer(param.extraOptions).array(param.name));
                });
        }

        if (actionMetadata.isAuthorizedUsed) {
            defaultMiddlewares.push((context: any, next: Function) => {
                if (!this.authorizationChecker)
                    throw new AuthorizationCheckerNotDefinedError();

                const action: Action = {request: context.request, response: context.response, context, next};
                const checkResult = actionMetadata.authorizedRoles instanceof Function ?
                    getFromContainer<RoleChecker>(actionMetadata.authorizedRoles).check(action) :
                    this.authorizationChecker(action, actionMetadata.authorizedRoles);

                const handleError = (result: any) => {
                    if (!result) {
                        let error = actionMetadata.authorizedRoles.length === 0 ? new AuthorizationRequiredError(action) : new AccessDeniedError(action);
                        return this.handleError(error, actionMetadata, action);
                    } else {
                        next();
                    }
                };

                if (isPromiseLike(checkResult)) {
                    checkResult.then(result => handleError(result));
                } else {
                    handleError(checkResult);
                }
            });
        }

        // user used middlewares
        const uses = actionMetadata.controllerMetadata.uses.concat(actionMetadata.uses);
        const beforeMiddlewares = this.prepareMiddlewares(uses.filter(use => !use.afterAction));
        const afterMiddlewares = this.prepareMiddlewares(uses.filter(use => use.afterAction));

        // prepare route and route handler function
        const route = ActionMetadata.appendBaseRoute(this.routePrefix, actionMetadata.fullRoute);
        const routeHandler = (context: any, next: () => Promise<any>) => {
            const options: Action = {request: context.request, response: context.response, context, next};
            return executeCallback(options);
        };

        // finally register action in koa
        this.router[actionMetadata.type.toLowerCase()](...[
            route,
            ...beforeMiddlewares,
            ...defaultMiddlewares,
            routeHandler,
            ...afterMiddlewares
        ]);
    }

    /**
     * Registers all routes in the framework.
     */
    registerRoutes() {
        this.koa.use(this.router.routes());
        this.koa.use(this.router.allowedMethods());
    }

    /**
     * Gets param from the request.
     */
    getParamFromRequest(actionOptions: Action, param: ParamMetadata): any {
        const context = actionOptions.context;
        const request: any = actionOptions.request;
        switch (param.type) {
            case "body":
                return request.body;

            case "body-param":
                return request.body[param.name];

            case "param":
                return context.params[param.name];

            case "params":
                return context.params;

            case "session":
                if (param.name)
                    return context.session[param.name];
                return context.session;

            case "state":
                if (param.name)
                    return context.state[param.name];
                return context.state;

            case "query":
                return context.query[param.name];

            case "queries":
                return context.query;

            case "file":
                return actionOptions.context.req.file;

            case "files":
                return actionOptions.context.req.files;

            case "header":
                return context.headers[param.name.toLowerCase()];

            case "headers":
                return request.headers;

            case "cookie":
                if (!context.headers.cookie) return;
                const cookies = cookie.parse(context.headers.cookie);
                return cookies[param.name];

            case "cookies":
                if (!request.headers.cookie) return {};
                return cookie.parse(request.headers.cookie);
        }
    }

    /**
     * Handles result of successfully executed controller action.
     */
    handleSuccess(result: any, action: ActionMetadata, options: Action): void {

        // check if we need to transform result and do it
        if (this.useClassTransformer && result && result instanceof Object) {
            const options = action.responseClassTransformOptions || this.classToPlainTransformOptions;
            result = classToPlain(result, options);
        }

        // set http status code
        if (result === undefined && action.undefinedResultCode && action.undefinedResultCode instanceof Function) {
            throw new (action.undefinedResultCode as any)(options);
        } 
        else if (result === null && action.nullResultCode) {
            if (action.nullResultCode instanceof Function) {
                throw new (action.nullResultCode as any)(options);
            }
        } else if (action.successHttpCode) {
            options.response.status = action.successHttpCode;
        }

        // apply http headers
        Object.keys(action.headers).forEach(name => {
            options.response.set(name, action.headers[name]);
        });

        if (action.redirect) { // if redirect is set then do it
            if (typeof result === "string") {
                options.response.redirect(result);
            } else if (result instanceof Object) {
                options.response.redirect(templateUrl(action.redirect, result));
            } else {
                options.response.redirect(action.redirect);
            }

            return options.next();

        } else if (action.renderedTemplate) { // if template is set then render it // TODO: not working in koa
            const renderOptions = result && result instanceof Object ? result : {};

            this.koa.use(async function (ctx: any, next: any) {
                await ctx.render(action.renderedTemplate, renderOptions);
            });

            return options.next();
        }
        else if (result != null) { // send regular result
            if (result instanceof Object) {
                options.response.body = result;
            } else {
                options.response.body = result;
            }

            return options.next();
        }
        else if (result === undefined) { // throw NotFoundError on undefined response
            const notFoundError = new NotFoundError();
            if (action.undefinedResultCode) {
                notFoundError.httpCode = action.undefinedResultCode as number;
            }
            throw notFoundError;
        }
        else { // send null response
            if (action.isJsonTyped) {
                options.response.body = null;
            } else {
                options.response.body = null;
            }

            // Setting `null` as a `response.body` means to koa that there is no content to return
            // so we must reset the status codes here.
            if (action.nullResultCode) {
                options.response.status = action.nullResultCode;
            } else {
                options.response.status = 204;
            }

            return options.next();
        }
    }

    /**
     * Handles result of failed executed controller action.
     */
    handleError(error: any, action: ActionMetadata | undefined, options: Action): any {
        return new Promise((resolve, reject) => {
            if (this.isDefaultErrorHandlingEnabled) {
                // set http status
                if (error instanceof HttpError && error.httpCode) {
                    options.response.status = error.httpCode;
                } else {
                    options.response.status = 500;
                }

                // apply http headers
                if (action) {
                    Object.keys(action.headers).forEach(name => {
                        options.response.set(name, action.headers[name]);
                    });
                }

                // send error content
                if (action && action.isJsonTyped) {
                    options.response.body = this.processJsonError(error);
                } else {
                    options.response.body = this.processTextError(error);
                }

                return resolve();
            }
            return reject(error);
        });
    }

    // -------------------------------------------------------------------------
    // Protected Methods
    // -------------------------------------------------------------------------

    /**
     * Creates middlewares from the given "use"-s.
     */
    protected prepareMiddlewares(uses: UseMetadata[]) {
        const middlewareFunctions: Function[] = [];
        uses.forEach(use => {
            if (use.middleware.prototype && use.middleware.prototype.use) { // if this is function instance of MiddlewareInterface
                middlewareFunctions.push((context: any, next: (err?: any) => Promise<any>) => {
                    try {
                        const useResult = (getFromContainer(use.middleware) as KoaMiddlewareInterface).use(context, next);
                        if (isPromiseLike(useResult)) {
                            useResult.catch((error: any) => {
                                this.handleError(error, undefined, {
                                    request: context.req,
                                    response: context.res,
                                    context,
                                    next
                                });
                                return error;
                            });
                        }

                        return useResult;
                    } catch (error) {
                        this.handleError(error, undefined, {
                            request: context.request,
                            response: context.response,
                            context,
                            next
                        });
                    }
                });

            } else {
                middlewareFunctions.push(use.middleware);
            }
        });
        return middlewareFunctions;
    }

    /**
     * Dynamically loads koa and required koa-router module.
     */
    protected loadKoa() {
        if (require) {
            if (!this.koa) {
                try {
                    this.koa = new (require("koa"))();
                } catch (e) {
                    throw new Error("koa package was not found installed. Try to install it: npm install koa@next --save");
                }
            }
        } else {
            throw new Error("Cannot load koa. Try to install all required dependencies.");
        }
    }

    /**
     * Dynamically loads koa-router module.
     */
    private loadRouter() {
        if (require) {
            if (!this.router) {
                try {
                    this.router = new (require("koa-router"))();
                } catch (e) {
                    throw new Error("koa-router package was not found installed. Try to install it: npm install koa-router@next --save");
                }
            }
        } else {
            throw new Error("Cannot load koa. Try to install all required dependencies.");
        }
    }

    /**
     * Dynamically loads koa-multer module.
     */
    private loadMulter() {
        try {
            return require("koa-multer");
        } catch (e) {
            throw new Error("koa-multer package was not found installed. Try to install it: npm install koa-multer --save");
        }
    }

}